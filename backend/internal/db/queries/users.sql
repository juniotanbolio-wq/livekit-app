-- name: CreateUser :one
INSERT INTO users (id, username, password_hash, is_admin, created_at)
VALUES (?, ?, ?, ?, ?)
RETURNING *;

-- name: GetUserByUsername :one
SELECT * FROM users WHERE username = ?;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = ?;

-- name: SetUserAdmin :exec
UPDATE users SET is_admin = 1 WHERE id = ?;
