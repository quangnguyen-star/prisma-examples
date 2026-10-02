/**
 * ONE READER FOR EVERY ENV FILE THE PIPELINE WRITES OR READS (tool backlog).
 *
 * stagingenv.mjs writes each value raw, so a PEM key spans several lines:
 * `PUBLIC_KEY=-----BEGIN PUBLIC KEY-----`, the base64 body, the END line. Every
 * reader used to split on newlines on its own, so PUBLIC_KEY was the header
 * alone. record.mjs got a PEM-aware parser in 121491f, and the others kept
 * theirs: stage 6's `vitest.coverage.config.mts` measured pricing-ms with a
 * key the code could not decode, `src/utils/cipher.ts` threw
 * `error:1E08010C:DECODER routines::unsupported` at import, and 94 of 184
 * emitted tests failed as harness errors. So there is one parser, here, and
 * every loader imports it.
 *
 * A value that opens with `-----BEGIN ...-----` takes the lines below it up to
 * and including its END line; a blank line ends an unterminated block. Every
 * other line that is not an assignment is ignored. `export NAME=` and
 * surrounding whitespace are accepted. A double-quoted value has `\n` read as
 * a newline.
 */
import { createPrivateKey, createPublicKey, privateEncrypt, publicDecrypt, constants } from "node:crypto";

export function parseEnvText(text) {
  const out = {};
  let open = null;
  for (const line of String(text ?? "").split("\n")) {
    if (open !== null && line.trim() === "") open = null;
    if (open !== null) {
      out[open] += `\n${line}`;
      if (/-----END [^-]+-----/.test(line)) open = null;
      continue;
    }
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const raw = m[2];
    out[m[1]] = /^".*"$/.test(raw) ? raw.slice(1, -1).replace(/\\n/g, "\n") : raw.replace(/^["']|["']$/g, "");
    if (/^-----BEGIN [^-]+-----$/.test(out[m[1]].trim())) open = m[1];
  }
  return out;
}

/** The names an env file sets, in file order. */
export function envNames(text) {
  return Object.keys(parseEnvText(text));
}

/**
 * THE INERT STAND-IN FOR A KEY, of the same kind, that the code can decode.
 *
 * `charpilot-placeholder` in PUBLIC_KEY is a value no crypto call accepts, so
 * a service that parses its key on import cannot even be loaded - a tool
 * failure, not a divergence. The stand-in is one fixed RSA key pair made for
 * this purpose and true of nothing; it is kept as DER here, not armoured, and
 * the pair is fixed so recorded.env does not change from one emit to the
 * next. A PEM label this does not know is left to the caller.
 */
const PLACEHOLDER_KEY_DER = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCTeS1KFIcRrDbtEYJEUL0q6UI4q+6wEFTli2B1jbu8nnu56vuHqN6LULYZ4mPjkQJbxn6G1nR146A3PABGaNkyB4xJYRRWHpdzijU58U9QxAR4oliOjXhrC1xnbBdOHp3TVZ4vibBqGPMaiXGbaP0j/Nh5jyzPdZaGg0Fyz928EQnR855icyU+/Ag+o3jo/7zgRBt3Ji+5TyZSRs0R9AUd1cZCp32lX6v3FUDfa+NX5cLq+LZf3cdA8v7bGXsfI7KlyCj9Q09+gL4LiD4loH86u2wz+QeJ0Wx1drhfxhBOKsQZK62/R7PXjZUN+z6/oRG+mcqc7n8H/Qt7fgbgv9XjAgMBAAECggEAKJtFrq+/T0zxpM5c5a2roMywqMUiyIT+s2Pwz/2SU4n5/IPo9X44pPi446C0K32KvjWGMl+LmshuHbdeRgTpxT5R0QSzolDzF+PW6xj4Y39N0d+17a6jmSn8LBgVxLNmdsIM9/78PgKXsddlmkrK5SVif/o99vPkWi57D3+QCQ/m5I2bSUNElbarrjZJ+ka8J9RdaKYT62cvj74lnZXSrqLfr9lcOfQM29vrnxBLJGQeAGl+TAGlKykHfzLyMPl+x68Hz2tqknA+8XxGXO+kRTtYlczBsRKugYY7WpxyTD00H52KMjGUA7Iij6WasXtN5sieCTWaRj4i9BZ0G0DndQKBgQDJ99+hBUOYXlpwD5OJbanTXzhxO7X3CwGjG5Wo3N4mE2E1f9NWvThFFbjSoAIAfBpoHZEaJdSP1eVs3yvuG+4edS8ePjPnanzhUdgzkO1+/mgfKlwAhlJupbBiHYf1vMyRX2crcYXcxhw6TxokL6Pf3EybrsoTkr8VxuTblyrEVQKBgQC67SFgdvYrK037RvlKle6YBEa2Wq8bzDaWgEJtDRELSect+m52i22Mi+COPPmKnBRorRwLK9CjhzIpZ/U4WXWwxddOVoSFrhpT9yzj+96V6SC42EESTvSCmaLfbc39gSOEqVvYPcz81d9ESq0tReaaz+proQmUUvDPwsdmUi+pVwKBgGMRnnVqkpyj87KyQUmRLFONiq8offqfQH9UoZXCOYntyaoneHA8wuRIYm+Wo0S/m2hk0G9GDT08y5wa4H6c3rG8A4/PLUCfoIAZ2HZ66bR4cHSRH632NWsnBR0rpSxqHuJULNRHjEUePGxxrr3/TGAbvMxE8cSmH+s7s7jvLsA9AoGAQJjiB+wUdiao9EU6sUPPCEmyBiKgkQKpeqkoS3dQhI4tjf4VXnIgkYllOMJpmjUF+IaaQmIJ3/lApH6Ah9Cik0xLc48CjQ/1mT66DK9l5HiEDlztX95ZMSjW2E+h+BFArP+59ailxlpCpd8IqbSWVLm1USx9mvxuq92r+vg78FECgYEAw1pidgMDr9r+pmReCAZqyI3JUBaZeocm9bvrs3UQGKqKmQfBMmP3+tGykINZxuNL8ptQDN3mx4TwGqqqHgnh+GCl+BEmhzuYhWfh/g4XHIqAo78yYqgDmOecsQ3DZxTY7/HCL8IrOarzegREnz8nddxH3JQIxDm4DVFxzQZlHNM=";
const PLACEHOLDER_PRIVATE = createPrivateKey({ key: Buffer.from(PLACEHOLDER_KEY_DER, "base64"), format: "der", type: "pkcs8" });
const PLACEHOLDER_PUBLIC = createPublicKey(PLACEHOLDER_PRIVATE);
export const PLACEHOLDER_PLAINTEXT = "charpilot-placeholder";

export function placeholderPem(value) {
  const label = /^-----BEGIN ([^-]+)-----/.exec(String(value ?? "").trim())?.[1];
  if (label === "PUBLIC KEY") return PLACEHOLDER_PUBLIC.export({ type: "spki", format: "pem" }).trim();
  if (label === "RSA PUBLIC KEY") return PLACEHOLDER_PUBLIC.export({ type: "pkcs1", format: "pem" }).trim();
  if (label === "PRIVATE KEY") return PLACEHOLDER_PRIVATE.export({ type: "pkcs8", format: "pem" }).trim();
  if (label === "RSA PRIVATE KEY") return PLACEHOLDER_PRIVATE.export({ type: "pkcs1", format: "pem" }).trim();
  return null;
}

/**
 * A value that is CIPHERTEXT under a public key the same env carries, as the
 * same kind of ciphertext under the placeholder key.
 *
 * pricing-ms keeps STRIPE_SECRET_KEY encrypted with a private key and
 * decrypts it on import with `crypto.publicDecrypt(PUBLIC_KEY, value)`. With
 * the key replaced, the recorded ciphertext no longer decrypts, and neither
 * does `charpilot-placeholder`; both throw at import. So a value that
 * publicDecrypt accepts under a recorded public key is replaced by
 * `charpilot-placeholder` encrypted under the placeholder private key, which
 * the placeholder public key decrypts. PKCS#1 v1.5 private-key padding is
 * deterministic, so the stamp is stable. Nothing recorded survives: not the
 * key, not the ciphertext, not what it decrypted to.
 */
export function placeholderCiphertext(value, recordedKeys) {
  const v = String(value ?? "");
  if (!/^[A-Za-z0-9+/=\s]{16,}$/.test(v)) return null;
  for (const key of recordedKeys) {
    for (const padding of [constants.RSA_PKCS1_PADDING]) {
      try {
        publicDecrypt({ key, padding }, Buffer.from(v, "base64"));
      } catch {
        continue;
      }
      return standInCiphertext();
    }
  }
  return null;
}

/**
 * `charpilot-placeholder` as CIPHERTEXT under the placeholder private key, in
 * `encoding` ("base64" or "hex"): what `publicDecrypt` under the placeholder
 * public key decrypts, with PKCS#1 v1.5 padding (its default). That padding is
 * deterministic, so one encoding is one value, every run. standins.mjs gives
 * it to a name the source decrypts (cryptoUsesIn).
 */
export function standInCiphertext(encoding = "base64") {
  return privateEncrypt({ key: PLACEHOLDER_PRIVATE, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(PLACEHOLDER_PLAINTEXT)).toString(encoding === "hex" ? "hex" : "base64");
}
