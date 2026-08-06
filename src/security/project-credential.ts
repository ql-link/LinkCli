import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class ProjectCredentialCipher {
  private readonly key: Buffer;

  constructor(base64Key: string, public readonly keyId: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) {
      throw new Error("Project credential key must be 32 bytes");
    }
  }

  encrypt(value: string | null | undefined): string | null {
    if (!value) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
  }

  decrypt(value: string | null): string | null {
    if (!value) return null;
    const [format, iv, tag, encrypted] = value.split(":");
    if (format !== "v1" || !iv || !tag || !encrypted) {
      throw new Error("Unsupported project credential ciphertext");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  }
}
