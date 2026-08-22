-- Community token lists ("lists as plugins").
--
-- Unlike asset_collections (registry-seeded, asset_id-keyed), token lists are
-- owned by a project, managed entirely through the API, and mint-keyed so a
-- list can include tokens the registry doesn't know. Member rows snapshot
-- symbol/name/logo/decimals at add time for mints resolved outside the
-- registry; reads prefer live hydration and fall back to the snapshot.

CREATE TABLE token_lists (
    id               text PRIMARY KEY,
    slug             text NOT NULL,
    owner_project_id text NOT NULL REFERENCES projects(id),
    name             text NOT NULL,
    description      text,
    status           text NOT NULL DEFAULT 'published'
                     CHECK (status IN ('draft', 'published', 'archived')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX token_lists_by_slug ON token_lists (slug);
CREATE INDEX token_lists_by_owner ON token_lists (owner_project_id);

CREATE TABLE token_list_members (
    id         text PRIMARY KEY,
    list_id    text NOT NULL REFERENCES token_lists(id) ON DELETE CASCADE,
    mint       text NOT NULL,
    rank       integer NOT NULL,
    note       text,
    -- Unix ms, matching asset_collection_members.added_at.
    added_at   bigint NOT NULL,
    -- Snapshot of provider metadata for mints unknown to the registry/tokens
    -- table at add time; null when the mint resolved locally.
    symbol     text,
    name       text,
    logo_uri   text,
    decimals   integer
);

CREATE UNIQUE INDEX token_list_members_by_list_and_mint ON token_list_members (list_id, mint);
CREATE INDEX token_list_members_by_list_and_rank ON token_list_members (list_id, rank);

INSERT INTO schema_migrations(version) VALUES ('0012_token_lists');
