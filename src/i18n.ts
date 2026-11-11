import type { FastifyRequest } from "fastify";

export type Lang = "en" | "pl";
const SUPPORTED: readonly Lang[] = ["en", "pl"];
const DEFAULT_LANG: Lang = "en";

const en = {
  "page.title.password": "Password required",
  "page.title.expired": "Link unavailable",
  "page.title.error": "Error",
  "page.title.folder": "Shared folder",
  "file.meta": "Shared file",
  "file.button": "Download",
  "folder.meta": "Shared folder",
  "folder.body":
    "Folder browsing is not yet available. Use a WebDAV client for full access.",
  "folder.empty": "This folder is empty.",
  "folder.section.folders": "Folders",
  "folder.section.files": "Files",
  "folder.zip_button": "Download all as ZIP",
  "folder.back_to_root": "Back to share root",
  "folder.subfolder_label": "Subfolder",
  "password.heading": "Password required",
  "password.lead":
    "This share is password-protected. Enter the password to continue.",
  "password.label": "Password",
  "password.button": "Unlock",
  "password.error.required": "Password is required.",
  "password.error.wrong": "Incorrect password. Please try again.",
  "password.error.rate_limited":
    "Too many password attempts right now. Please wait a minute and try again.",
  "password.show": "Show password",
  "password.hide": "Hide password",
  "expired.heading": "Link unavailable",
  "expired.body": "This link has expired or never existed.",
  "error.heading": "Something went wrong",
  "error.body":
    "Try again in a moment. If the problem persists, contact the share owner.",
} as const;

export type Key = keyof typeof en;

const pl: Record<Key, string> = {
  "page.title.password": "Wymagane hasło",
  "page.title.expired": "Link niedostępny",
  "page.title.error": "Błąd",
  "page.title.folder": "Udostępniony folder",
  "file.meta": "Udostępniony plik",
  "file.button": "Pobierz",
  "folder.meta": "Udostępniony folder",
  "folder.body":
    "Przeglądanie zawartości folderów nie jest jeszcze dostępne. Skorzystaj z klienta WebDAV, aby uzyskać pełny dostęp.",
  "folder.empty": "Ten folder jest pusty.",
  "folder.section.folders": "Foldery",
  "folder.section.files": "Pliki",
  "folder.zip_button": "Pobierz całość jako ZIP",
  "folder.back_to_root": "Wróć do głównego folderu",
  "folder.subfolder_label": "Podfolder",
  "password.heading": "Wymagane hasło",
  "password.lead": "Ten zasób jest chroniony hasłem. Wpisz je poniżej, aby kontynuować.",
  "password.label": "Hasło",
  "password.button": "Odblokuj",
  "password.error.required": "Hasło jest wymagane.",
  "password.error.wrong": "Nieprawidłowe hasło. Spróbuj ponownie.",
  "password.error.rate_limited":
    "Zbyt wiele prób podania hasła. Odczekaj minutę i spróbuj ponownie.",
  "password.show": "Pokaż hasło",
  "password.hide": "Ukryj hasło",
  "expired.heading": "Link niedostępny",
  "expired.body": "Ten link wygasł lub nigdy nie istniał.",
  "error.heading": "Coś poszło nie tak",
  "error.body":
    "Spróbuj ponownie za chwilę. Jeśli problem się powtarza, skontaktuj się z właścicielem zasobu.",
};

const DICT: Record<Lang, Record<Key, string>> = { en, pl };

export function translate(key: Key, lang: Lang): string {
  return DICT[lang][key];
}

export type T = (key: Key) => string;

export function makeT(lang: Lang): T {
  return (key) => DICT[lang][key];
}

export function resolveLang(req: FastifyRequest): Lang {
  const q = (req.query as { lang?: unknown } | undefined)?.lang;
  if (typeof q === "string" && (SUPPORTED as readonly string[]).includes(q)) {
    return q as Lang;
  }
  const header = req.headers["accept-language"];
  return parseAcceptLanguage(header);
}

export function parseAcceptLanguage(header: string | string[] | undefined): Lang {
  if (!header) return DEFAULT_LANG;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return DEFAULT_LANG;

  for (const part of raw.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase();
    if (!tag) continue;
    const primary = tag.split("-")[0];
    if (primary && (SUPPORTED as readonly string[]).includes(primary)) {
      return primary as Lang;
    }
  }
  return DEFAULT_LANG;
}
