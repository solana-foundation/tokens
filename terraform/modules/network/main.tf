resource "google_project_service" "services" {
  for_each = toset([
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "vpcaccess.googleapis.com",
  ])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_network" "vpc" {
  name                    = "tokens-vpc-${var.env}"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  depends_on              = [google_project_service.services]
}

resource "google_compute_subnetwork" "subnet" {
  name                     = "tokens-subnet-${var.env}${var.name_suffix}"
  ip_cidr_range            = "10.20.0.0/24"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  private_ip_google_access = true

  dynamic "log_config" {
    for_each = var.flow_logs == null ? [] : [var.flow_logs]
    content {
      aggregation_interval = log_config.value.aggregation_interval
      flow_sampling        = log_config.value.flow_sampling
      metadata             = log_config.value.metadata
      filter_expr          = log_config.value.filter_expr
    }
  }
}

resource "google_compute_global_address" "psa_range" {
  name          = "tokens-psa-${var.env}"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa_range.name]
}

resource "google_compute_router" "nat_router" {
  name    = "tokens-router-${var.env}${var.name_suffix}"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_address" "nat_static" {
  name         = "tokens-nat-static-${var.env}"
  region       = var.region
  address_type = "EXTERNAL"
  description  = "Static egress IP for Cloud NAT — whitelisted at ClickHouse / Hetzner. Rotating this breaks ClickHouse-driven crons."
}

resource "google_compute_router_nat" "nat" {
  name                               = "tokens-nat-${var.env}"
  router                             = google_compute_router.nat_router.name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.nat_static.self_link]
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
  enable_dynamic_port_allocation     = true
  min_ports_per_vm                   = 64
  max_ports_per_vm                   = 16384
  tcp_time_wait_timeout_sec          = 30

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

resource "google_compute_firewall" "deny_egress_default" {
  name      = "tokens-deny-egress-default-${var.env}"
  network   = google_compute_network.vpc.name
  direction = "EGRESS"
  priority  = 65534

  deny {
    protocol = "all"
  }

  destination_ranges = ["0.0.0.0/0"]
}

resource "google_compute_firewall" "allow_egress_internal" {
  name      = "tokens-allow-egress-internal-${var.env}"
  network   = google_compute_network.vpc.name
  direction = "EGRESS"
  priority  = 1000

  allow {
    protocol = "all"
  }

  destination_ranges = [
    "10.0.0.0/8",
    "${google_compute_global_address.psa_range.address}/${google_compute_global_address.psa_range.prefix_length}",
  ]
}

resource "google_compute_firewall" "allow_egress_https" {
  name      = "tokens-allow-egress-https-${var.env}"
  network   = google_compute_network.vpc.name
  direction = "EGRESS"
  priority  = 1000

  allow {
    protocol = "tcp"
    ports    = ["443", "8123", "8443"]
  }

  destination_ranges = ["0.0.0.0/0"]
}
