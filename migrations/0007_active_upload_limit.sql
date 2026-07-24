CREATE TRIGGER IF NOT EXISTS limit_active_upload_sessions
BEFORE INSERT ON upload_sessions
WHEN NEW.status = 'active'
  AND (
    SELECT COUNT(*)
    FROM upload_sessions
    WHERE principal_id = NEW.principal_id AND status = 'active'
  ) >= 20
BEGIN
  SELECT RAISE(ABORT, 'too_many_active_uploads');
END;
