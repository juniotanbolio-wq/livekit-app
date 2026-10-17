-- +goose Up
-- Datas são guardadas como segundos Unix (UTC): comparação trivial no SQL e nenhuma ambiguidade de formato.

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    -- NOCASE: "Admin" e "admin" são o mesmo usuário (evita personificação por maiúsculas).
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    is_admin      BOOLEAN NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
);

-- O código do convite nunca é guardado em claro: só o SHA-256. Um vazamento do banco não entrega convites usáveis.
CREATE TABLE invites (
    id         TEXT PRIMARY KEY,
    code_hash  TEXT    NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    used_at    INTEGER,
    used_by    TEXT REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE channels (
    id       TEXT PRIMARY KEY,
    name     TEXT    NOT NULL,
    position INTEGER NOT NULL UNIQUE
);

-- +goose Down
DROP TABLE channels;
DROP TABLE invites;
DROP TABLE users;
