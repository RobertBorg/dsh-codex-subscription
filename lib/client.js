window.__ModuleLoader__.load({
  id: 'dsh-llm-codex',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const {
      createElement: h,
      useCallback,
      useEffect,
      useRef,
      useState,
      useSyncExternalStore,
    } = React;

    const ROUTE = '/api/plugins/dsh-llm-codex/usage';
    const STYLE_ID = 'dsh-llm-codex/usage.css';
    const CSS = `
.dsh-codex-usage{position:relative;display:inline-flex;align-items:center}
.dsh-codex-usage__trigger{height:28px;max-width:142px;padding:0 7px;border:0;border-radius:24px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:500 12px/20px system-ui,sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}
.dsh-codex-usage__trigger:hover,.dsh-codex-usage__trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,currentColor)}
.dsh-codex-usage__trigger[data-tone=warning]{color:var(--dsw-alias-state-warn-primary,#d69e2e)}.dsh-codex-usage__trigger[data-tone=danger]{color:var(--dsw-alias-state-error-primary,#e05252)}
.dsh-codex-usage__panel{position:absolute;right:0;bottom:calc(100% + 8px);z-index:100;box-sizing:border-box;width:280px;padding:12px;border:1px solid var(--dsw-alias-border-inverted,rgba(127,127,127,.25));border-radius:12px;background:var(--dsw-specific-menu,#181818);color:var(--dsw-alias-label-primary,#eee);box-shadow:var(--dsw-shadow-lv3,0 10px 30px rgba(0,0,0,.28));font:12px/20px system-ui,sans-serif}
.dsh-codex-usage__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.dsh-codex-usage__plan{font-weight:600}.dsh-codex-usage__updated{color:var(--dsw-alias-label-tertiary,#999);font-size:10px}
.dsh-codex-usage__window+.dsh-codex-usage__window{margin-top:10px}.dsh-codex-usage__line{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px}.dsh-codex-usage__label{color:var(--dsw-alias-label-secondary,#aaa)}.dsh-codex-usage__value{font-weight:500;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-codex-usage__track{height:4px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,#383838)}.dsh-codex-usage__fill{height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary,#4ea66b)}.dsh-codex-usage__fill[data-tone=warning]{background:var(--dsw-alias-state-warn-primary,#d69e2e)}.dsh-codex-usage__fill[data-tone=danger]{background:var(--dsw-alias-state-error-primary,#e05252)}
.dsh-codex-usage__error{margin:0;color:var(--dsw-alias-state-error-primary,#e98282);overflow-wrap:anywhere}
`;

    function tone(percent) {
      if (percent >= 90) return 'danger';
      if (percent >= 70) return 'warning';
      return 'ok';
    }

    function planLabel(value) {
      if (typeof value !== 'string' || value.length === 0) return 'Codex';
      return `Codex ${value.charAt(0).toUpperCase()}${value.slice(1)}`;
    }

    function resetLabel(value) {
      const timestamp = Date.parse(value ?? '');
      if (!Number.isFinite(timestamp)) return '';
      const minutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60000));
      if (minutes < 60) return `resets in ${minutes}m`;
      const hours = Math.ceil(minutes / 60);
      if (hours < 48) return `resets in ${hours}h`;
      return `resets in ${Math.ceil(hours / 24)}d`;
    }

    function UsageWindow({ label, value }) {
      if (value === null || value === undefined) return null;
      const used = Math.round(value.usedPercent);
      const reset = resetLabel(value.resetsAt);
      const state = tone(used);
      return h('div', { className: 'dsh-codex-usage__window' },
        h('div', { className: 'dsh-codex-usage__line' },
          h('span', { className: 'dsh-codex-usage__label' }, label),
          h('span', { className: 'dsh-codex-usage__value' }, `${used}% used${reset === '' ? '' : ` · ${reset}`}`),
        ),
        h('div', { className: 'dsh-codex-usage__track' },
          h('div', {
            className: 'dsh-codex-usage__fill',
            'data-tone': state,
            style: { width: `${used}%` },
          }),
        ),
      );
    }

    function latestCompletedTurn(turnEnds) {
      let latest = -1;
      for (const turn of turnEnds.keys()) latest = Math.max(latest, turn);
      return latest;
    }

    function providerForTurn(nodes, turn) {
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (node?.kind !== 'assistant' || node.turn !== turn) continue;
        return node.provenance?.provider ?? node.requestConfig?.provider;
      }
      return undefined;
    }

    function UsageControl({ directory, loadDirectory, session }) {
      const directoryState = useSyncExternalStore(
        (notify) => directory.subscribe(notify),
        () => directory.getSnapshot(),
        () => directory.getSnapshot(),
      );
      const provider = directoryState.current?.provider;
      const [usage, setUsage] = useState(null);
      const [error, setError] = useState(null);
      const [open, setOpen] = useState(false);
      const root = useRef(null);
      const completedTurn = latestCompletedTurn(session.turnEnds);
      const completedProvider = providerForTurn(session.nodes, completedTurn);
      const observedCompletedTurn = useRef(completedTurn);

      useEffect(() => { loadDirectory(); }, [loadDirectory]);

      const refresh = useCallback(async (signal) => {
        try {
          const response = await fetch(ROUTE, {
            method: 'GET',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
            signal,
          });
          const body = await response.json();
          if (!response.ok || body.status === 'error') throw new Error(body.error ?? 'Unable to read Codex usage.');
          setUsage(body);
          setError(null);
        } catch (cause) {
          if (signal.aborted) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, []);

      useEffect(() => {
        if (provider !== 'codex') {
          setOpen(false);
          return undefined;
        }
        const controller = new AbortController();
        void refresh(controller.signal);
        return () => { controller.abort(); };
      }, [provider, refresh]);

      // Opening the detail surface asks the Host for a fresh view. Its
      // five-minute cache decides whether this reaches a new app-server process.
      useEffect(() => {
        if (!open || provider !== 'codex') return undefined;
        const controller = new AbortController();
        void refresh(controller.signal);
        return () => { controller.abort(); };
      }, [open, provider, refresh]);

      // A newly closed turn refreshes only when its recorded request used Codex.
      // Older history loading cannot trigger this because only a greater turn id
      // advances the watermark. Missing legacy provenance falls back to the
      // currently selected provider.
      useEffect(() => {
        const previous = observedCompletedTurn.current;
        observedCompletedTurn.current = completedTurn;
        if (completedTurn <= previous) return undefined;
        if ((completedProvider ?? provider) !== 'codex') return undefined;
        const controller = new AbortController();
        void refresh(controller.signal);
        return () => { controller.abort(); };
      }, [completedProvider, completedTurn, provider, refresh]);

      useEffect(() => {
        if (!open) return undefined;
        const pointer = (event) => {
          if (event.target instanceof Node && root.current?.contains(event.target)) return;
          setOpen(false);
        };
        const key = (event) => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('pointerdown', pointer);
        document.addEventListener('keydown', key);
        return () => {
          document.removeEventListener('pointerdown', pointer);
          document.removeEventListener('keydown', key);
        };
      }, [open]);

      if (provider !== 'codex' || usage?.status === 'unavailable') return null;
      const sessionUsed = usage?.session?.usedPercent;
      const weekly = usage?.weekly?.usedPercent;
      const maximum = Math.max(sessionUsed ?? 0, weekly ?? 0);
      const readings = [
        Number.isFinite(sessionUsed) ? `S ${Math.round(sessionUsed)}%` : null,
        Number.isFinite(weekly) ? `W ${Math.round(weekly)}%` : null,
      ].filter(Boolean);
      const label = usage === null
        ? (error === null ? 'Codex …' : 'Codex !')
        : readings.join(' · ');

      return h('span', { className: 'dsh-codex-usage', ref: root },
        h('button', {
          type: 'button',
          className: 'dsh-codex-usage__trigger',
          'data-tone': tone(maximum),
          'aria-label': `Codex plan usage: ${label}`,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        }, label),
        open && h('div', { className: 'dsh-codex-usage__panel', role: 'dialog', 'aria-label': 'Codex plan usage' },
          error !== null
            ? h('p', { className: 'dsh-codex-usage__error' }, error)
            : usage === null
              ? h('p', null, 'Loading Codex usage…')
              : h(React.Fragment, null,
                  h('div', { className: 'dsh-codex-usage__head' },
                    h('span', { className: 'dsh-codex-usage__plan' }, planLabel(usage.planType)),
                    h('span', { className: 'dsh-codex-usage__updated' }, 'Plan usage'),
                  ),
                  h(UsageWindow, { label: 'Session', value: usage.session }),
                  h(UsageWindow, { label: 'Weekly', value: usage.weekly }),
                ),
        ),
      );
    }

    const name = 'llm-codex-usage';
    const inject = ['slots', 'modelDirectories'];

    function apply(ctx) {
      ctx.effect(() => {
        if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return undefined;
        const style = document.createElement('style');
        style.dataset.plugin = 'dsh-llm-codex';
        style.dataset.pluginCss = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => { style.remove(); };
      }, 'llm-codex: usage styles');

      ctx.inject(['slots', 'modelDirectories'], (scope) => {
        scope.slots.inject('conversation.input.right', () => scope.slots.register({
          name: 'conversation.input.right',
          id: 'codex-plan-usage',
          order: 10,
          inject: (sessionId) => {
            const directory = scope.modelDirectories.directoryFor(sessionId);
            return {
              directory: directory.store,
              loadDirectory: () => { directory.load().catch(() => undefined); },
            };
          },
        }, UsageControl));
      });
    }

    module.exports = { name, inject, apply, default: { name, inject, apply } };
    return module.exports;
  },
});
