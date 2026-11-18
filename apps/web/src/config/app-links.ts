/**
 * SP-0200: the two links office staff share so salesmen can install the Field app.
 * Fixed values on purpose (not env vars): the Play test link and the Drive folder never change;
 * the Drive folder always holds the newest app file, so link the folder, never a file.
 */
export const FIELD_APP_LINKS = [
  {
    key: "play",
    name: "Google Play",
    label: "Field app on Google Play",
    url: "https://play.google.com/apps/internaltest/4701513704454726563",
    hint: "Open on the phone, sign in with the invited Gmail, tap Accept invite, then Download it on Google Play.",
  },
  {
    key: "drive",
    name: "Google Drive",
    label: "App file on Google Drive (backup)",
    url: "https://drive.google.com/drive/folders/181uAAjyMxw08WoDKSGaumrTPPZvQA282",
    hint: "Use only if Google Play shows an error. Download the file and install it over the old app. Never uninstall first.",
  },
] as const;

export type FieldAppLink = (typeof FIELD_APP_LINKS)[number];
