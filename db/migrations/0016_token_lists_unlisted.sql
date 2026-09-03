-- Community token lists: add the 'unlisted' status.
--
-- Unlisted = hidden from the public catalog (GET /api/v2/lists) and from
-- mint→slug annotations, but the direct read path (/api/v2/lists/{slug})
-- still serves anyone with the link. The dashboard presents it as "Unlisted".
-- 'draft' keeps its stricter meaning (hidden from all public reads).

ALTER TABLE token_lists DROP CONSTRAINT token_lists_status_check;
ALTER TABLE token_lists ADD CONSTRAINT token_lists_status_check
    CHECK (status IN ('draft', 'unlisted', 'published', 'archived'));

INSERT INTO schema_migrations(version) VALUES ('0016_token_lists_unlisted');
