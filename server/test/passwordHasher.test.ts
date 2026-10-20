import { describe, expect, it } from "vitest";
import { createPasswordHasher } from "../src/infra/security/passwordHasher.js";

const hasher = createPasswordHasher({
	memoryKib: 19456,
	timeCost: 2,
	parallelism: 1,
});

// A real scrypt PHC string in the exact shape the Rust server writes
// ($scrypt$ln=17,r=8,p=1, N=131072, 128 MiB). Generated with Node using
// the same parameters for password "password123"; the import rehearsal
// in Phase 2 verifies a hash the Rust binary itself produced.
const RUST_SHAPED_HASH =
	"$scrypt$ln=17,r=8,p=1$qTlzE02wYo31TuJXKUXERQ$avf9raHgUi0rcRS+zvLOnqZJujbE9iAnzojXIR7EdSaZnlMZmbR3QaDRYsAvzhKLtB7HmS0ItPH3XKxxWNfg4Q";

describe("argon2id passwords", () => {
	it("round-trips a hash with the configured parameters", async () => {
		const hash = await hasher.hash("password123");

		expect(hash.startsWith("$argon2id$")).toBe(true);
		expect(await hasher.verify(hash, "password123")).toBe(true);
		expect(await hasher.verify(hash, "wrongpassword")).toBe(false);
		expect(hasher.needsRehash(hash)).toBe(false);
	});

	it("rejects malformed and foreign hashes without throwing", async () => {
		expect(await hasher.verify("not-a-hash", "password123")).toBe(false);
		expect(await hasher.verify("$argon2id$v=19$m=1,t=1,p=1$c2FsdA$broken", "x")).toBe(
			false,
		);
	});
});

describe("legacy scrypt passwords", () => {
	it("verifies a Rust-shaped scrypt hash and flags it for rehash", async () => {
		expect(await hasher.verify(RUST_SHAPED_HASH, "password123")).toBe(true);
		expect(await hasher.verify(RUST_SHAPED_HASH, "wrongpassword")).toBe(false);
		expect(hasher.needsRehash(RUST_SHAPED_HASH)).toBe(true);
	});

	it("does not block the event loop while verifying scrypt (P9)", async () => {
		// The legacy hash costs ~400 ms of CPU. verify() runs it on
		// libuv, so the loop keeps ticking and other requests are served
		// meanwhile; a synchronous scrypt would starve them to ~zero ticks.
		let done = false;
		let ticks = 0;
		const counting = (async () => {
			while (!done) {
				ticks += 1;
				await new Promise((resolve) => setImmediate(resolve));
			}
		})();

		const ok = await hasher.verify(RUST_SHAPED_HASH, "password123");
		done = true;
		await counting;

		expect(ok).toBe(true);
		expect(ticks).toBeGreaterThan(10);
	});

	it("rejects a truncated scrypt string without throwing", async () => {
		expect(await hasher.verify("$scrypt$ln=17,r=8,p=1$abc", "x")).toBe(false);
	});
});
