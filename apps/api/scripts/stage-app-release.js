// F-006: stage an already signed APK; private signing keys never enter the API or release register.
import { stageApk } from "../src/domains/integrity/apk-artifacts.js";
const source = process.argv[2];
if (!source)
  throw new Error(
    "Usage: bun scripts/stage-app-release.js /absolute/path/to/signed.apk",
  );
console.log(JSON.stringify(await stageApk(source), null, 2));
