// Package api contém o servidor gerado pelo oapi-codegen a partir de contracts/openapi.yaml.
// Não edite api.gen.go: mude o contrato e rode scripts\generate.ps1.
package api

//go:generate go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0 -config oapi-codegen.yaml ../../../contracts/openapi.yaml
