// epoch-join-e2e helper: verify the fixed e2e payload signature against a
// sign_pk taken from the canonical epoch (org member list --json).
// argv: <sign_pk_b64> <sig_b64url> [n]  → prints VERIFY_OK / VERIFY_FAIL.
import { verifyMemberPayload } from "../src/member-identity.ts";

const [signPk, sig, nRaw] = process.argv.slice(2);
if (!signPk || !sig) {
  console.error("usage: e2e-verify-payload.ts <sign_pk> <sig> [n]");
  process.exit(2);
}
const payload = { msg: "org-epoch-join-e2e", n: Number(nRaw ?? "1") };
const ok = verifyMemberPayload(signPk, payload, sig);
console.log(ok ? "VERIFY_OK" : "VERIFY_FAIL");
process.exit(ok ? 0 : 1);
