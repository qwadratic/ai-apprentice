// The email digital twin: "Northwind Mail", a static page (apps/web/public/twin/mail) that the expert opens in another browser tab
// and shares like any real app, so Clipa reads it through the generic vision path and not through the built-in demo workspace.

/** The Vite base path (`/clipa/` on Pages). Node tests render the shell without import.meta.env, hence the fallback. */
const BASE_URL: string = import.meta.env?.BASE_URL ?? '/';

/** The twin's start page (the inbox; its "Twin case" menu and `?case=a|b|c|d` open a ready-made draft). */
export const TWIN_MAIL_URL = `${BASE_URL}twin/mail/index.html`;
