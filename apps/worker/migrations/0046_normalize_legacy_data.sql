UPDATE matches
SET record_json = json_set(record_json, '$.game.drawProposals', json('[]'))
WHERE game = 'four-shogi'
  AND json_type(record_json, '$.game.drawProposals') IS NULL;

UPDATE "user"
SET "createdAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt" / 1000.0, 'unixepoch')
WHERE typeof("createdAt") = 'integer';

UPDATE "user"
SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', "updatedAt" / 1000.0, 'unixepoch')
WHERE typeof("updatedAt") = 'integer';
