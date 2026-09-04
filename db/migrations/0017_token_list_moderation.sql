-- Community token lists: moderation lock, slug hold-down, and a mint index.
--
-- admin_locked_at (unix ms): set by the admin emergency takedown. While set,
-- every owner mutation (update/rename/delete/member writes) is refused, so an
-- abuser cannot flip an archived list back to published. Cleared only by the
-- admin unlock RPC.
--
-- token_list_slug_holds: when a slug is freed (list deleted or renamed away),
-- it is held for the original owner for a window (TOKEN_LIST_SLUG_HOLD_DAYS,
-- default 30) so consumers pinned to /v2/lists/{slug} cannot be silently
-- served attacker-chosen tokens under the old list's reputation.

ALTER TABLE token_lists ADD COLUMN admin_locked_at bigint;

CREATE TABLE token_list_slug_holds (
    slug             text PRIMARY KEY,
    owner_project_id text NOT NULL,
    -- Unix ms when the slug was released.
    released_at      bigint NOT NULL
);

-- listSlugsByMints filters WHERE m.mint IN (...) on every curator search;
-- without this it seq-scans the whole members table.
CREATE INDEX token_list_members_by_mint ON token_list_members (mint);

INSERT INTO schema_migrations(version) VALUES ('0017_token_list_moderation');
