import { HandleTakenError } from "../../domain/errors.js";
import type { UserRecord, UserRepository } from "../../domain/ports.js";
import type { DbClient } from "./client.js";

type PrismaUser = {
	id: string;
	handle: string;
	handleKey: string;
	passwordHash: string;
	createdAt: Date;
};

/** One repository per aggregate (REFACTORING.md section 5). Translates
 * storage failures into domain language; nothing Prisma-flavoured
 * leaves this module. */
export function createUserRepository(db: DbClient): UserRepository {
	return {
		async findByHandleKey(handleKey: string): Promise<UserRecord | null> {
			const user = await db.user.findUnique({ where: { handleKey } });
			return user && toRecord(user);
		},

		async findById(id: string): Promise<UserRecord | null> {
			const user = await db.user.findUnique({ where: { id } });
			return user && toRecord(user);
		},

		async create(input: {
			id: string;
			handle: string;
			handleKey: string;
			passwordHash: string;
		}): Promise<UserRecord> {
			try {
				const user = await db.$transaction(async (tx) => {
					const created = await tx.user.create({ data: input });
					await tx.userSync.create({ data: { userId: created.id } });
					return created;
				});
				return toRecord(user);
			} catch (error: unknown) {
				if (isUniqueViolation(error)) {
					// handle_key is the only unique column, so a conflict
					// here is always the concurrent-register race.
					throw new HandleTakenError();
				}
				throw error;
			}
		},

		async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
			await db.user.update({ where: { id }, data: { passwordHash } });
		},
	};
}

function toRecord(user: PrismaUser): UserRecord {
	return {
		id: user.id,
		handle: user.handle,
		handleKey: user.handleKey,
		passwordHash: user.passwordHash,
		createdAt: user.createdAt,
	};
}

/** P2002 is Prisma's stable unique-violation code. Structural check
 * instead of instanceof: the generated client re-exports the error
 * class as a type alias, which cannot narrow. */
function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "P2002"
	);
}
