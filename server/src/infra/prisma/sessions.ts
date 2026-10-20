import type {
	SessionRecord,
	SessionRepository,
	UserRecord,
} from "../../domain/ports.js";
import type { DbClient } from "./client.js";

export function createSessionRepository(db: DbClient): SessionRepository {
	return {
		async create(input: {
			tokenHash: string;
			userId: string;
			expiresAt: Date;
		}): Promise<SessionRecord> {
			const session = await db.session.create({ data: input });
			return toRecord(session);
		},

		async findWithUser(
			tokenHash: string,
		): Promise<{ session: SessionRecord; user: UserRecord } | null> {
			const session = await db.session.findUnique({
				where: { tokenHash },
				include: { user: true },
			});
			if (!session) {
				return null;
			}
			return { session: toRecord(session), user: toUserRecord(session.user) };
		},

		async deleteByTokenHash(tokenHash: string): Promise<void> {
			await db.session.deleteMany({ where: { tokenHash } });
		},

		async deleteExpired(now: Date): Promise<number> {
			const result = await db.session.deleteMany({
				where: { expiresAt: { lte: now } },
			});
			return result.count;
		},
	};
}

function toRecord(session: {
	tokenHash: string;
	userId: string;
	expiresAt: Date;
}): SessionRecord {
	return {
		tokenHash: session.tokenHash,
		userId: session.userId,
		expiresAt: session.expiresAt,
	};
}

function toUserRecord(user: {
	id: string;
	handle: string;
	handleKey: string;
	passwordHash: string;
	createdAt: Date;
}): UserRecord {
	return {
		id: user.id,
		handle: user.handle,
		handleKey: user.handleKey,
		passwordHash: user.passwordHash,
		createdAt: user.createdAt,
	};
}
