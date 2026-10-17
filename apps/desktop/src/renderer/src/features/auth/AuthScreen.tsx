import { useState, type FormEvent } from 'react';
import {
  inviteCodeSchema,
  passwordSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  usernameSchema,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '@livekit-app/shared';
import { ApiError } from '../../lib/api';
import { useSession } from '../../stores/session';
import { Spinner } from '../../components/Icons';

type Mode = 'login' | 'register';
type Field = 'inviteCode' | 'username' | 'password' | 'confirm';
type FieldErrors = Partial<Record<Field, string>>;

const MESSAGES = {
  inviteCode: 'Informe o código de convite que você recebeu',
  username: `Use de ${USERNAME_MIN_LENGTH} a ${USERNAME_MAX_LENGTH} caracteres: letras, números, ponto, hífen ou sublinhado`,
  password: `A senha precisa ter de ${PASSWORD_MIN_LENGTH} a ${PASSWORD_MAX_LENGTH} caracteres`,
  confirm: 'As senhas não conferem',
};

function validate(mode: Mode, values: Record<Field, string>): FieldErrors {
  const errors: FieldErrors = {};
  if (mode === 'register' && !inviteCodeSchema.safeParse(values.inviteCode).success) {
    errors.inviteCode = MESSAGES.inviteCode;
  }
  if (!usernameSchema.safeParse(values.username).success) {
    errors.username = MESSAGES.username;
  }
  if (!passwordSchema.safeParse(values.password).success) {
    errors.password = MESSAGES.password;
  }
  if (mode === 'register' && values.password !== values.confirm) {
    errors.confirm = MESSAGES.confirm;
  }
  return errors;
}

function describeError(err: unknown, mode: Mode): string {
  if (err instanceof ApiError) {
    if (err.status === 0) {
      return err.message;
    }
    if (err.status === 401 && mode === 'login') {
      return 'Usuário ou senha incorretos';
    }
    if (err.status === 409) {
      return 'Este nome de usuário já está em uso';
    }
    if (err.status === 429) {
      return 'Muitas tentativas. Aguarde alguns minutos e tente de novo';
    }
    return err.message;
  }
  return 'Erro inesperado. Tente novamente';
}

interface InputProps {
  id: Field;
  label: string;
  type?: string;
  value: string;
  error: string | undefined;
  autoComplete: string;
  onChange(value: string): void;
}

function Input({ id, label, type = 'text', value, error, autoComplete, onChange }: InputProps) {
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-1 block text-xs font-semibold tracking-wide text-zinc-300 uppercase">
        {label}
      </span>
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-md border bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-2 focus:ring-indigo-500 ${
          error ? 'border-red-500' : 'border-zinc-700'
        }`}
      />
      {error && <span className="mt-1 block text-xs text-red-400">{error}</span>}
    </label>
  );
}

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [values, setValues] = useState<Record<Field, string>>({
    inviteCode: '',
    username: '',
    password: '',
    confirm: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const notice = useSession((state) => state.notice);
  const login = useSession((state) => state.login);
  const register = useSession((state) => state.register);
  const clearNotice = useSession((state) => state.clearNotice);

  const setField = (field: Field) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setErrors({});
    setSubmitError(null);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    clearNotice();
    setSubmitError(null);
    const found = validate(mode, values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }
    setSubmitting(true);
    try {
      const username = values.username.trim();
      if (mode === 'login') {
        await login({ username, password: values.password });
      } else {
        await register({
          inviteCode: values.inviteCode.trim(),
          username,
          password: values.password,
        });
      }
    } catch (err) {
      setSubmitError(describeError(err, mode));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-zinc-900 p-6">
      <form
        onSubmit={onSubmit}
        noValidate
        className="w-full max-w-sm space-y-4 rounded-lg bg-zinc-800 p-8 shadow-xl"
      >
        <div className="text-center">
          <h1 className="text-xl font-semibold">
            {mode === 'login' ? 'Bem-vindo de volta' : 'Criar conta'}
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            {mode === 'login'
              ? 'Entre com seu usuário e senha'
              : 'Você precisa de um código de convite'}
          </p>
        </div>

        {notice && (
          <div className="rounded-md bg-amber-500/15 px-3 py-2 text-sm text-amber-300">
            {notice}
          </div>
        )}

        {mode === 'register' && (
          <Input
            id="inviteCode"
            label="Código de convite"
            value={values.inviteCode}
            error={errors.inviteCode}
            autoComplete="off"
            onChange={setField('inviteCode')}
          />
        )}
        <Input
          id="username"
          label="Usuário"
          value={values.username}
          error={errors.username}
          autoComplete="username"
          onChange={setField('username')}
        />
        <Input
          id="password"
          label="Senha"
          type="password"
          value={values.password}
          error={errors.password}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          onChange={setField('password')}
        />
        {mode === 'register' && (
          <Input
            id="confirm"
            label="Confirmar senha"
            type="password"
            value={values.confirm}
            error={errors.confirm}
            autoComplete="new-password"
            onChange={setField('confirm')}
          />
        )}

        {submitError && (
          <div role="alert" className="rounded-md bg-red-500/15 px-3 py-2 text-sm text-red-300">
            {submitError}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {submitting && <Spinner />}
          {mode === 'login' ? 'Entrar' : 'Cadastrar'}
        </button>

        <p className="text-center text-sm text-zinc-400">
          {mode === 'login' ? 'Tem um convite? ' : 'Já tem conta? '}
          <button
            type="button"
            onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
            className="text-indigo-400 hover:underline"
          >
            {mode === 'login' ? 'Cadastre-se' : 'Entrar'}
          </button>
        </p>
      </form>
    </div>
  );
}
