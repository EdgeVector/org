// epoch-join-e2e helper: sign the fixed e2e payload with the LOCAL member
// identity (honors ORG_MEMBER_IDENTITY_PATH). Prints the base64url signature.
import { loadMemberIdentity, signMemberPayload } from "../src/member-identity.ts";

const n = Number(process.argv[2] ?? "1");
const payload = { msg: "org-epoch-join-e2e", n };
console.log(signMemberPayload(loadMemberIdentity(), payload));
