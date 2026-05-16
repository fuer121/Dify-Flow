import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
const MASTER_KEY_BYTES = 32;

let cachedMasterKey = null;

export async function getMasterKey() {
  if (cachedMasterKey) return cachedMasterKey;

  if (process.env.NODE_ENV === "test" && process.env.NOVEL_SERVICE_TEST_MASTER_KEY) {
    cachedMasterKey = decodeKey(process.env.NOVEL_SERVICE_TEST_MASTER_KEY);
    return cachedMasterKey;
  }

  const existing = await readKeychainPassword();
  if (existing) {
    cachedMasterKey = decodeKey(existing);
    return cachedMasterKey;
  }

  const key = crypto.randomBytes(MASTER_KEY_BYTES);
  await writeKeychainPassword(key.toString("base64"));
  cachedMasterKey = key;
  return key;
}

export function clearMasterKeyCache() {
  cachedMasterKey = null;
}

export async function encryptText(plaintext, aad = "") {
  const key = await getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext || ""), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export async function decryptText(payload, aad = "") {
  if (!payload?.ciphertext || !payload?.iv || !payload?.tag) {
    throw new Error("密文结构不完整，无法解密。");
  }

  const key = await getMasterKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );
  if (aad) decipher.setAAD(Buffer.from(String(aad), "utf8"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

export async function hmacText(value) {
  const key = await getMasterKey();
  return crypto.createHmac("sha256", key).update(String(value || ""), "utf8").digest("hex");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export async function rotateMasterKey(reencrypt) {
  const oldKey = await getMasterKey();
  const nextKey = crypto.randomBytes(MASTER_KEY_BYTES);
  cachedMasterKey = nextKey;
  await reencrypt(oldKey, nextKey);
  await writeKeychainPassword(nextKey.toString("base64"));
  return true;
}

async function readKeychainPassword() {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      config.keychain.service,
      "-a",
      config.keychain.account,
      "-w"
    ]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function writeKeychainPassword(value) {
  await execFileAsync("security", [
    "add-generic-password",
    "-U",
    "-s",
    config.keychain.service,
    "-a",
    config.keychain.account,
    "-w",
    value
  ]);
}

function decodeKey(value) {
  const key = Buffer.from(String(value || ""), "base64");
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error("Keychain 中的主密钥长度无效。");
  }
  return key;
}
