-- 保存済みのレート戦をバッジに反映し、過去の獲得通知は生成しません。
WITH own_matches AS (
    SELECT h.account_id, m.id AS match_id, m.mode, m.game, m.record_json,
      json_extract(m.record_json, '$.game.result') AS result,
      (SELECT json_extract(p.value, '$.color')
       FROM json_each(m.record_json, '$.participants') p
       WHERE json_extract(p.value, '$.kind') = 'human'
         AND COALESCE(json_extract(p.value, '$.retired'),0) != 1
         AND (json_extract(p.value, '$.accountId') = h.account_id OR
           (json_extract(p.value, '$.accountId') IS NULL AND EXISTS (
             SELECT 1 FROM match_participant_accounts c
             WHERE c.match_id=m.id AND c.player_id=json_extract(p.value, '$.id')
               AND c.account_id=h.account_id AND c.state='applied')))) AS direction
    FROM account_match_history h JOIN matches m ON m.id = h.match_id
    WHERE h.game = 'four-reversi' AND m.game = h.game
      AND json_array_length(m.record_json, '$.participants') = 4
      AND (NOT EXISTS (
        SELECT 1 FROM json_each(m.record_json, '$.participants') participant
        WHERE json_extract(participant.value, '$.kind') IS NOT 'human'
      ) OR (m.mode = 'singles' AND json_type(m.record_json, '$.fourReversiRating') = 'object'))
  ), outcomes AS (
    SELECT account_id, match_id, mode, direction, result,
      (SELECT json_extract(s.value, '$.rank')
       FROM json_each(result, '$.standings') s
       WHERE json_extract(s.value, '$.color') = own_matches.direction) AS rank,
      json_extract(result, '$.winner') AS winner,
      CASE WHEN direction IN ('black', 'red') THEN 'black-red' ELSE 'white-blue' END AS team,
      0 AS knockouts
    FROM own_matches WHERE direction IS NOT NULL
  ), totals AS (
    SELECT account_id, COUNT(*) AS games, SUM(rank = 1) AS wins,
      SUM(knockouts) AS knockouts,
      SUM(CASE WHEN rank = 1 AND knockouts = 3
        AND json_extract(result, '$.reason') = 'last_player'
        AND (SELECT COUNT(*) FROM json_each(result, '$.standings') s
          WHERE json_extract(s.value, '$.rank') = 1) = 1 THEN 1 ELSE 0 END) AS perfect_wins
    FROM outcomes WHERE mode = 'singles' GROUP BY account_id
  ), thresholds(badge_id, tier, threshold) AS (VALUES ('games', 1, 5), ('games', 2, 20), ('games', 3, 100), ('wins', 1, 3), ('wins', 2, 15), ('wins', 3, 50)), values_by_badge AS (
    SELECT account_id, badge_id, tier, threshold,
      CASE badge_id WHEN 'games' THEN games WHEN 'wins' THEN wins
        WHEN 'knockouts' THEN knockouts ELSE perfect_wins END AS value
    FROM totals CROSS JOIN thresholds
  )
  INSERT INTO account_badge_awards (account_id, game, badge_id, tier, value, previous_tier, match_id)
  SELECT account_id, 'four-reversi', badge_id, tier, value,
    COALESCE((SELECT MAX(a.tier) FROM account_badge_awards a
      WHERE a.account_id = v.account_id AND a.game = 'four-reversi' AND a.badge_id = v.badge_id), 0),
    NULL
  FROM values_by_badge v WHERE value >= threshold
  ON CONFLICT(account_id, game, badge_id, tier) DO NOTHING;

WITH own_matches AS (
    SELECT h.account_id, m.id AS match_id, m.mode, m.game, m.record_json,
      json_extract(m.record_json, '$.game.result') AS result,
      (SELECT json_extract(p.value, '$.side')
       FROM json_each(m.record_json, '$.participants') p
       WHERE json_extract(p.value, '$.kind') = 'human'
         AND COALESCE(json_extract(p.value, '$.retired'),0) != 1
         AND (json_extract(p.value, '$.accountId') = h.account_id OR
           (json_extract(p.value, '$.accountId') IS NULL AND EXISTS (
             SELECT 1 FROM match_participant_accounts c
             WHERE c.match_id=m.id AND c.player_id=json_extract(p.value, '$.id')
               AND c.account_id=h.account_id AND c.state='applied')))) AS direction
    FROM account_match_history h JOIN matches m ON m.id = h.match_id
    WHERE h.game = 'four-shogi' AND m.game = h.game
      AND json_array_length(m.record_json, '$.participants') = 4
      AND (NOT EXISTS (
        SELECT 1 FROM json_each(m.record_json, '$.participants') participant
        WHERE json_extract(participant.value, '$.kind') IS NOT 'human'
      ) OR (m.mode = 'singles' AND json_type(m.record_json, '$.fourShogiRating') = 'object'))
  ), outcomes AS (
    SELECT account_id, match_id, mode, direction, result,
      (SELECT json_extract(s.value, '$.rank')
       FROM json_each(result, '$.standings') s
       WHERE json_extract(s.value, '$.side') = own_matches.direction) AS rank,
      json_extract(result, '$.winner') AS winner,
      CASE WHEN direction IN ('south', 'north') THEN 'south-north' ELSE 'west-east' END AS team,
      CASE WHEN mode = 'singles' THEN COALESCE(json_extract(record_json, '$.knockouts.' || direction), 0) ELSE 0 END AS knockouts
    FROM own_matches WHERE direction IS NOT NULL
  ), totals AS (
    SELECT account_id, COUNT(*) AS games, SUM(rank = 1) AS wins,
      SUM(knockouts) AS knockouts,
      SUM(CASE WHEN rank = 1 AND knockouts = 3
        AND json_extract(result, '$.reason') = 'last_player'
        AND (SELECT COUNT(*) FROM json_each(result, '$.standings') s
          WHERE json_extract(s.value, '$.rank') = 1) = 1 THEN 1 ELSE 0 END) AS perfect_wins
    FROM outcomes WHERE mode = 'singles' GROUP BY account_id
  ), thresholds(badge_id, tier, threshold) AS (VALUES ('games', 1, 5), ('games', 2, 20), ('games', 3, 100), ('wins', 1, 3), ('wins', 2, 15), ('wins', 3, 50), ('knockouts', 1, 3), ('knockouts', 2, 15), ('knockouts', 3, 50), ('perfect-wins', 1, 1), ('perfect-wins', 2, 2), ('perfect-wins', 3, 3)), values_by_badge AS (
    SELECT account_id, badge_id, tier, threshold,
      CASE badge_id WHEN 'games' THEN games WHEN 'wins' THEN wins
        WHEN 'knockouts' THEN knockouts ELSE perfect_wins END AS value
    FROM totals CROSS JOIN thresholds
  )
  INSERT INTO account_badge_awards (account_id, game, badge_id, tier, value, previous_tier, match_id)
  SELECT account_id, 'four-shogi', badge_id, tier, value,
    COALESCE((SELECT MAX(a.tier) FROM account_badge_awards a
      WHERE a.account_id = v.account_id AND a.game = 'four-shogi' AND a.badge_id = v.badge_id), 0),
    NULL
  FROM values_by_badge v WHERE value >= threshold
  ON CONFLICT(account_id, game, badge_id, tier) DO NOTHING;
