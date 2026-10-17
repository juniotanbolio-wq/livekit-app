import { ServerIcon } from '../../components/Icons';
import { useSession } from '../../stores/session';
import { ServerAddressForm } from './ServerAddressForm';

// Primeira execução (ou "Alterar" na tela de login): o app não tem endereço fixo de servidor.
export function ServerSetupScreen({ onCancel }: { onCancel?: () => void }) {
  const serverUrl = useSession((state) => state.serverUrl);
  const defaultServerUrl = useSession((state) => state.defaultServerUrl);
  const notice = useSession((state) => state.notice);

  return (
    <div
      className="flex h-full items-center justify-center bg-zinc-900 p-6"
      data-screen="server-setup"
    >
      <div className="w-full max-w-sm space-y-4 rounded-lg bg-zinc-800 p-8 shadow-xl">
        <div className="text-center">
          <ServerIcon size={32} className="mx-auto mb-2 text-indigo-400" />
          <h1 className="text-xl font-semibold">Conectar a um servidor</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Informe o endereço do servidor do grupo. Ele é verificado antes de ser salvo.
          </p>
        </div>
        {notice && (
          <div className="rounded-md bg-amber-500/15 px-3 py-2 text-sm text-amber-300">
            {notice}
          </div>
        )}
        <ServerAddressForm
          initialValue={serverUrl ?? defaultServerUrl ?? ''}
          submitLabel="Conectar"
          autoFocus
        />
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="w-full text-center text-sm text-zinc-400 hover:text-zinc-200"
          >
            Voltar
          </button>
        )}
        {serverUrl && (
          <p className="text-center text-xs text-zinc-500">
            Trocar de servidor encerra a sessão salva neste computador.
          </p>
        )}
      </div>
    </div>
  );
}
