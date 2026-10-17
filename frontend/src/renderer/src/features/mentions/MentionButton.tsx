import { useState } from 'react';
import { BellIcon } from '../../components/Icons';
import { MentionDialog, type MentionTarget } from './MentionDialog';

// Sino que aparece ao passar o mouse sobre alguém na lista de participantes (a linha precisa da classe `group`).
export function MentionButton({ target }: { target: MentionTarget }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        title={`Chamar atenção de ${target.username}`}
        aria-label={`Chamar atenção de ${target.username}`}
        data-mention-target={target.username}
        onClick={() => setOpen(true)}
        className="rounded p-0.5 text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-zinc-700 hover:text-amber-400 focus-visible:opacity-100"
      >
        <BellIcon size={14} />
      </button>
      {open && <MentionDialog target={target} onClose={() => setOpen(false)} />}
    </>
  );
}
