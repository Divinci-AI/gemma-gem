/**
 * Production Auth0 client id, in a module that imports NOTHING and touches no
 * `import.meta`.
 *
 * It lives apart from divinci-account.ts so that `wxt.config.ts` can read it for
 * the zip guard WITHOUT importing a module that uses `import.meta.env`. That
 * matters for more than tidiness: to let esbuild drop the STAGING branch from a
 * production bundle, divinci-account.ts must use the bare, statically
 * replaceable `import.meta.env.DEV` — which throws under the config loader,
 * where `import.meta.env` does not exist. Splitting the constant out is what
 * lets both hold at once.
 */

/** Sentinel meaning "the production Auth0 application has not been created yet". */
export const PROD_AUTH0_CLIENT_ID_UNSET = '__SET_PROD_AUTH0_CLIENT_ID__'

/**
 * Auth0 SPA application (PKCE, no secret) for the PRODUCTION tenant
 * `divinci-prod.us.auth0.com`.
 *
 * To fill it: Auth0 dashboard → divinci-prod → Applications → Create → Single
 * Page Application → Allowed Callback URLs
 * `https://<extension-id>.chromiumapp.org/`, Allowed Web Origins
 * `chrome-extension://<extension-id>` → paste the Client ID here. The extension
 * id is assigned BY the Chrome Web Store at draft creation; see STORE_LISTING.md.
 *
 * `wxt.config.ts` refuses to `zip` a production build while this is the sentinel.
 */
export const PROD_AUTH0_CLIENT_ID: string = PROD_AUTH0_CLIENT_ID_UNSET
