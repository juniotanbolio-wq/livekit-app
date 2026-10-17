// Package db abre o SQLite e aplica as migrações embutidas no binário.
package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite" // driver "sqlite" em Go puro (sem cgo)
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open abre (criando, se preciso) o banco em path e aplica as migrações pendentes.
func Open(ctx context.Context, path string) (*sql.DB, error) {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("criar diretório do banco: %w", err)
		}
	}

	// Os pragmas vão no DSN porque valem por conexão, e o pool pode abrir novas a qualquer momento.
	// WAL permite leitura durante escrita; busy_timeout faz o SQLite esperar o lock em vez de falhar na hora;
	// foreign_keys vem desligado por padrão no SQLite.
	query := url.Values{}
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "foreign_keys(1)")
	dsn := "file:" + path + "?" + query.Encode()

	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("abrir banco: %w", err)
	}
	// Uma única conexão: o SQLite só aceita um escritor por vez, e transações que começam como leitura e
	// depois escrevem podem falhar com SQLITE_BUSY mesmo com busy_timeout. Para ~15 usuários, serializar
	// tudo é mais simples e seguro do que gerenciar locks.
	conn.SetMaxOpenConns(1)

	if err := conn.PingContext(ctx); err != nil {
		return nil, closeWith(conn, fmt.Errorf("conectar ao banco: %w", err))
	}
	if err := migrate(ctx, conn); err != nil {
		return nil, closeWith(conn, err)
	}
	return conn, nil
}

func migrate(ctx context.Context, conn *sql.DB) error {
	migrations, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("migrações embutidas: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectSQLite3, conn, migrations)
	if err != nil {
		return fmt.Errorf("preparar migrações: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("aplicar migrações: %w", err)
	}
	return nil
}

func closeWith(conn *sql.DB, cause error) error {
	if err := conn.Close(); err != nil {
		return errors.Join(cause, fmt.Errorf("fechar o banco: %w", err))
	}
	return cause
}
