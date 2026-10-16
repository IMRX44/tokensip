import {
  BookOpen,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  List,
  LogOut,
  Menu,
  Moon,
  Plug,
  Server,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Logo } from "./components/Logo";
import { ToastProvider } from "./components/ui";
import { LANGUAGES, type MessageKey, useI18n } from "./i18n";
import { type AuthState, api, type Catalog, setCsrf, setUnauthorizedHandler } from "./lib/api";
import { navigate, usePath } from "./lib/router";
import { useTheme } from "./lib/theme";
import { LoginPage, SetupPage } from "./pages/Auth";
import { IntegratePage } from "./pages/Integrate";
import { KeysPage } from "./pages/Keys";
import { LabPage } from "./pages/Lab";
import { OverviewPage } from "./pages/Overview";
import { ProvidersPage } from "./pages/Providers";
import { RequestsPage } from "./pages/Requests";
import { SettingsPage } from "./pages/Settings";

const NAV: { path: string; key: MessageKey; icon: ReactNode }[] = [
  { path: "/", key: "nav.overview", icon: <LayoutDashboard size={17} /> },
  { path: "/requests", key: "nav.requests", icon: <List size={17} /> },
  { path: "/lab", key: "nav.lab", icon: <FlaskConical size={17} /> },
  { path: "/providers", key: "nav.providers", icon: <Server size={17} /> },
  { path: "/keys", key: "nav.keys", icon: <KeyRound size={17} /> },
  { path: "/integrate", key: "nav.integrate", icon: <Plug size={17} /> },
  { path: "/settings", key: "nav.settings", icon: <SettingsIcon size={17} /> },
];

function Shell({ auth, catalog, onAuthChange }: { auth: AuthState; catalog: Catalog; onAuthChange(): void }) {
  const { t, lang, setLang } = useI18n();
  const [theme, setTheme] = useTheme();
  const path = usePath();
  const [open, setOpen] = useState(false);
  const dark = document.documentElement.dataset.theme !== "light";

  let page: ReactNode;
  switch (path) {
    case "/requests":
      page = <RequestsPage />;
      break;
    case "/lab":
      page = <LabPage catalog={catalog} />;
      break;
    case "/providers":
      page = <ProvidersPage catalog={catalog} />;
      break;
    case "/keys":
      page = <KeysPage catalog={catalog} />;
      break;
    case "/integrate":
      page = <IntegratePage />;
      break;
    case "/settings":
      page = <SettingsPage catalog={catalog} auth={auth} onAuthChange={onAuthChange} />;
      break;
    default:
      page = <OverviewPage />;
  }

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="brand">
          <Logo size={34} />
          <div>
            <div className="brand-name">TokenSip</div>
            <div className="brand-tag">
              v{catalog.version} · {catalog.mode}
            </div>
          </div>
        </div>
        {NAV.map((n) => (
          <a
            key={n.path}
            href={n.path}
            className={`nav-link ${path === n.path || (n.path === "/" && !NAV.some((x) => x.path === path)) ? "active" : ""}`}
            onClick={(e) => {
              e.preventDefault();
              setOpen(false);
              navigate(n.path);
            }}
          >
            {n.icon}
            {t(n.key)}
          </a>
        ))}
        <div className="sidebar-foot">
          <div className="row" style={{ gap: 6 }}>
            <select
              className="select"
              style={{ height: 32 }}
              value={lang}
              onChange={(e) => setLang(e.target.value as typeof lang)}
              aria-label={t("settings.language")}
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn sm icon-btn"
              aria-label={t("settings.theme")}
              onClick={() => setTheme(dark ? "light" : theme === "light" ? "dark" : "light")}
            >
              {dark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
          <a className="nav-link" href="https://github.com/IMRX44/tokensip" target="_blank" rel="noreferrer noopener">
            <BookOpen size={17} /> {t("nav.docs")}
          </a>
          <button
            type="button"
            className="nav-link"
            onClick={async () => {
              await api("/auth/logout", { method: "POST" }).catch(() => {});
              setCsrf(null);
              onAuthChange();
            }}
          >
            <LogOut size={17} /> {t("nav.logout")}
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="mobile-bar">
          <div className="row">
            <Logo size={28} />
            <b>TokenSip</b>
          </div>
          <button type="button" className="btn sm icon-btn" onClick={() => setOpen((o) => !o)} aria-label="menu">
            <Menu size={16} />
          </button>
        </div>
        {page}
      </main>
    </div>
  );
}

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);

  const refresh = useCallback(async () => {
    const state = await api<AuthState>("/auth/state");
    setCsrf(state.csrfToken);
    setAuth(state);
    if (state.authenticated) setCatalog(await api<Catalog>("/catalog"));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => void refresh());
    void refresh();
  }, [refresh]);

  let content: ReactNode = null;
  if (auth?.setupRequired) content = <SetupPage onDone={() => void refresh()} />;
  else if (auth && !auth.authenticated) content = <LoginPage totp={auth.totpEnabled} onDone={() => void refresh()} />;
  else if (auth && catalog) content = <Shell auth={auth} catalog={catalog} onAuthChange={() => void refresh()} />;

  return <ToastProvider>{content}</ToastProvider>;
}
