import argon2 from "argon2";
import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { PasswordHasher } from "../../domain/ports.js";

export interface PasswordHasherOptions {
	memoryKib: number;
	timeCost: number;
	parallelism: number;
}

/**
 * Argon2id hasher with a scrypt-PHC fallback. The fallback exists for
 * exactly one case: a password imported from the Rust server, whose
 * hashes are `$scrypt$ln=17,...` (N=131072, 128 MiB). Node's default
 * scrypt memory cap rejects those parameters, so the cap is raised from
 * the parameters themselves. D13: a legacy login rehashes to argon2id,
 * so the 128 MiB / ~400 ms cost is paid exactly once per imported user.
 */
export function createPasswordHasher(
	options: PasswordHasherOptions,
): PasswordHasher {
	return {
		async hash(password: string): Promise<string> {
			return argon2.hash(password, {
				type: argon2.argon2id,
				memoryCost: options.memoryKib,
				timeCost: options.timeCost,
				parallelism: options.parallelism,
			});
		},

		async verify(storedHash: string, password: string): Promise<boolean> {
			if (storedHash.startsWith("$argon2")) {
				try {
					return await argon2.verify(storedHash, password);
				} catch {
					return false;
				}
			}
			if (storedHash.startsWith("$scrypt$")) {
				try {
					return await verifyScryptPhc(storedHash, password);
				} catch {
					return false;
				}
			}
			return false;
		},

		needsRehash(storedHash: string): boolean {
			return !storedHash.startsWith("$argon2id$");
		},
	};
}

interface ScryptParams {
	n: number;
	r: number;
	p: number;
	salt: Buffer;
	hash: Buffer;
}

function parseScryptPhc(phc: string): ScryptParams {
	const match = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(phc);
	if (!match) {
		throw new Error("not a scrypt PHC string");
	}
	const [, ln, r, p, saltB64, hashB64] = match as unknown as string[] & {
		length: 6;
	};
	// PHC base64 is the standard alphabet with padding stripped;
	// Buffer handles the missing padding.
	return {
		n: 2 ** Number(ln),
		r: Number(r),
		p: Number(p),
		salt: Buffer.from(saltB64, "base64"),
		hash: Buffer.from(hashB64, "base64"),
	};
}

async function verifyScryptPhc(
	phc: string,
	password: string,
): Promise<boolean> {
	const { n, r, p, salt, hash } = parseScryptPhc(phc);
	// scrypt needs ~128*N*r*p bytes; Node caps far lower by default.
	const maxmem = Math.max(32 * 1024 * 1024, 128 * n * r * p + 1024 * 1024);
	const derived = await new Promise<Buffer>((resolve, reject) => {
		scryptCallback(
			password,
			salt,
			hash.length,
			{ N: n, r, p, maxmem },
			(error, key) => {
				if (error) {
					reject(error);
				} else {
					resolve(key as Buffer);
				}
			},
		);
	});
	return derived.length === hash.length && timingSafeEqual(derived, hash);
}
