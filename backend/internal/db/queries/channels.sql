-- name: ListChannels :many
SELECT * FROM channels ORDER BY position;

-- name: GetChannel :one
SELECT * FROM channels WHERE id = ?;

-- name: UpsertChannel :exec
INSERT INTO channels (id, name, position)
VALUES (?, ?, ?)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, position = excluded.position;
