-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "handle_key" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "user_sync" (
    "user_id" UUID NOT NULL,
    "next_seq" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "user_sync_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "tombstones" (
    "user_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_key" TEXT NOT NULL,
    "deleted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tombstones_pkey" PRIMARY KEY ("user_id","seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key_key" ON "users"("handle_key");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "tombstones_user_id_deleted_at_idx" ON "tombstones"("user_id", "deleted_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sync" ADD CONSTRAINT "user_sync_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
