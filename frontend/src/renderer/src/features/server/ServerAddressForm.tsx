import { useState, type FormEvent } from 'react';
import { Spinner } from '../../components/Icons';

interface ServerAddressFormProps {
  initialValue: string;
  submitLabel: string;
  autoFocus?: boolean;
}

// Valida e salva o endereço do servidor. Quem valida é o processo principal (GET /health): o renderer
// ainda não pode falar com um servidor que não está na CSP. Depois de salvar, a página recarrega para a
// CSP nova (com o servidor e o LiveKit) entrar em vigor.
export function ServerAddressForm({
  initialValue,
  submitLabel,
  autoFocus,
}: ServerAddressFormProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const result = await window.desktop.setServer(value);
      if (result.ok) {
        window.location.reload();
        return;
      }
      setError(result.error);
    } catch (err) {
      console.error('Falha ao salvar o servidor:', err);
      setError('Falha inesperada ao salvar o endereço do servidor');
    }
    setSaving(false);
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3" data-server-form>
      <label className="block" htmlFor="serverUrl">
        <span className="mb-1 block text-xs font-semibold tracking-wide text-zinc-300 uppercase">
          Endereço do servidor
        </span>
        <input
          id="serverUrl"
          type="url"
          value={value}
          autoFocus={autoFocus}
          spellCheck={false}
          placeholder="https://meuservidor.com"
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          aria-invalid={error ? true : undefined}
          className={`w-full rounded-md border bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-2 focus:ring-indigo-500 ${
            error ? 'border-red-500' : 'border-zinc-700'
          }`}
        />
      </label>
      {error && (
        <div
          role="alert"
          data-server-error
          className="rounded-md bg-red-500/15 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={saving}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
      >
        {saving && <Spinner />}
        {saving ? 'Verificando...' : submitLabel}
      </button>
    </form>
  );
}
