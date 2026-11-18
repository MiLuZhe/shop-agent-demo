-- A buyer may end a waiting consultation before any human has been assigned.
-- Keep its resolved inquiry for history without inventing a human assignee.
ALTER TABLE inquiries DROP CONSTRAINT inquiries_state_check;
ALTER TABLE inquiries ADD CONSTRAINT inquiries_state_check CHECK ((
  char_length(question) BETWEEN 1 AND 4000 AND question ~ '[^[:space:]]'
  AND reason IN ('user_request','missing_info','agent_failure','unresolved')
  AND status IN ('pending','processing','resolved')
  AND (status <> 'processing' OR assigned_seller_id IS NOT NULL)
  AND ((status = 'resolved' AND resolution IS NOT NULL AND resolution ~ '[^[:space:]]' AND resolved_at IS NOT NULL)
    OR (status <> 'resolved' AND resolved_at IS NULL))
));
