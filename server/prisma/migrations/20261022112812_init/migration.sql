-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handle" TEXT NOT NULL COLLATE NOCASE,
    "handle_key" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "sessions" (
    "token_hash" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_sync" (
    "user_id" TEXT NOT NULL PRIMARY KEY,
    "next_seq" BIGINT NOT NULL DEFAULT 1,
    CONSTRAINT "user_sync_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tombstones" (
    "user_id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_key" TEXT NOT NULL,
    "deleted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("user_id", "seq"),
    CONSTRAINT "tombstones_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sample_datasets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data_json" TEXT NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "change_seq" BIGINT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "sample_datasets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "printer_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "printer_name" TEXT NOT NULL,
    "settings_json" TEXT NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "change_seq" BIGINT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "printer_profiles_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "change_seq" BIGINT NOT NULL,
    "updated_at" DATETIME NOT NULL,

    PRIMARY KEY ("user_id", "key"),
    CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "fonts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT '',
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "change_seq" BIGINT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "fonts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "font_files" (
    "font_id" TEXT NOT NULL PRIMARY KEY,
    "bytes" BLOB NOT NULL,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "font_files_font_id_fkey" FOREIGN KEY ("font_id") REFERENCES "fonts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL COLLATE NOCASE,
    "summary" TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
    "page_w_mm" REAL NOT NULL,
    "page_h_mm" REAL NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'html',
    "body" TEXT NOT NULL,
    "css" TEXT NOT NULL DEFAULT '',
    "readme" TEXT NOT NULL DEFAULT '',
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "change_seq" BIGINT NOT NULL,
    "published_at" DATETIME,
    "first_published_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "templates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "saved_templates" (
    "user_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("user_id", "template_id"),
    CONSTRAINT "saved_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "template_use_daily" (
    "user_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "day" DATETIME NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("user_id", "template_id", "day"),
    CONSTRAINT "template_use_daily_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "template_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "css" TEXT NOT NULL DEFAULT '',
    "label" TEXT,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key_key" ON "users"("handle_key");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "tombstones_user_id_deleted_at_idx" ON "tombstones"("user_id", "deleted_at");

-- CreateIndex
CREATE INDEX "sample_datasets_owner_id_change_seq_idx" ON "sample_datasets"("owner_id", "change_seq");

-- CreateIndex
CREATE INDEX "printer_profiles_owner_id_change_seq_idx" ON "printer_profiles"("owner_id", "change_seq");

-- CreateIndex
CREATE UNIQUE INDEX "printer_profiles_owner_id_template_id_printer_name_key" ON "printer_profiles"("owner_id", "template_id", "printer_name");

-- CreateIndex
CREATE INDEX "user_settings_user_id_change_seq_idx" ON "user_settings"("user_id", "change_seq");

-- CreateIndex
CREATE INDEX "fonts_owner_id_change_seq_idx" ON "fonts"("owner_id", "change_seq");

-- CreateIndex
CREATE INDEX "templates_owner_id_change_seq_idx" ON "templates"("owner_id", "change_seq");

-- CreateIndex
CREATE INDEX "templates_owner_id_updated_at_idx" ON "templates"("owner_id", "updated_at");

-- CreateIndex
CREATE INDEX "templates_published_at_updated_at_idx" ON "templates"("published_at", "updated_at");

-- CreateIndex
CREATE INDEX "saved_templates_template_id_idx" ON "saved_templates"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_template_id_version_no_key" ON "template_versions"("template_id", "version_no");
