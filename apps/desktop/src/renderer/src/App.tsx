export function App() {
  return (
    <main className="flex h-full items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">LiveKit App</h1>
        <p className="mt-2 text-sm text-neutral-400">Plataforma: {window.desktop.platform}</p>
      </div>
    </main>
  );
}
