-- ATENCAO: nao use acentos nestes arquivos. O sqlc (engine sqlite) calcula deslocamentos em bytes e
-- corrompe o texto das consultas quando ha caracteres de varios bytes (inclusive em comentarios).
-- A explicacao de cada consulta fica em internal/service.

-- name: CreateInvite :exec
INSERT INTO invites (id, code_hash, expires_at, created_at)
VALUES (?, ?, ?, ?);

-- name: ConsumeInvite :execrows
UPDATE invites
SET used_at = ?1
WHERE code_hash = ?2
  AND used_at IS NULL
  AND expires_at > ?1;

-- name: SetInviteUsedBy :exec
UPDATE invites SET used_by = ? WHERE code_hash = ?;
