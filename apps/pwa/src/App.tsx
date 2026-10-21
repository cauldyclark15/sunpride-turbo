/** The frozen field pilot is not a v2 selling client (ADR-004/010). */
export default function App() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-5">
      <section className="w-full max-w-[440px] rounded-2xl border border-border bg-surface p-7">
        <img src="/sunpride-logo.jpg" alt="Sunpride" width="64" height="64" />
        <h1 className="mt-6 text-2xl font-semibold">
          Use the current Sunpride app
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          This field pilot is retired. Open the office app below, or use the
          Android field or van app supplied by your administrator.
        </p>
        <p className="mt-3 text-sm leading-6 text-muted">
          If this browser holds unsent work, do not uninstall it or clear its
          data. Ask your office to recover that work before recording it again.
        </p>
        <a
          className="mt-6 block rounded-[10px] border border-border p-3 text-center"
          href="https://sunpride.cauldnclark.com/today"
        >
          Open Sunpride
        </a>
      </section>
    </main>
  );
}
