-- Repair asset_variants.tags rows stored as a JSON string instead of an array.
--
-- The admin service's createVariant/updateVariant bound `JSON.stringify(tags)`
-- into a `::jsonb` parameter. postgres-js serializes json/jsonb-typed
-- parameters with JSON.stringify itself, so the value was encoded twice and
-- landed as a jsonb string ('"[\"PreStocks\"]"'). Readers only accept arrays
-- (`Array.isArray(row.tags) ? row.tags : []`), so those variants lost their
-- tags. The write sites now use `tx.json(...)`; this unwraps what is already
-- stored. Idempotent: a second run matches no rows.
UPDATE asset_variants
SET tags = (tags #>> '{}')::jsonb
WHERE jsonb_typeof(tags) = 'string'
  AND jsonb_typeof((tags #>> '{}')::jsonb) = 'array';
