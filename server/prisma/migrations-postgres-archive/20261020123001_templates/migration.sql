-- CreateEnum
CREATE TYPE "VersionSource" AS ENUM ('manual', 'autosave', 'restore');

-- CreateTable
CREATE TABLE "templates" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "page_w_mm" DOUBLE PRECISION NOT NULL,
    "page_h_mm" DOUBLE PRECISION NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'html',
    "body" TEXT NOT NULL,
    "css" TEXT NOT NULL DEFAULT '',
    "readme" TEXT NOT NULL DEFAULT '',
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "change_seq" BIGINT NOT NULL,
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_templates" (
    "user_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_templates_pkey" PRIMARY KEY ("user_id","template_id")
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "css" TEXT NOT NULL DEFAULT '',
    "label" TEXT,
    "note" TEXT,
    "created_by" "VersionSource" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "templates_owner_id_change_seq_idx" ON "templates"("owner_id", "change_seq");

-- CreateIndex
CREATE INDEX "templates_owner_id_updated_at_idx" ON "templates"("owner_id", "updated_at");

-- CreateIndex
CREATE INDEX "templates_published_at_updated_at_idx" ON "templates"("published_at", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_template_id_version_no_key" ON "template_versions"("template_id", "version_no");

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_templates" ADD CONSTRAINT "saved_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_templates" ADD CONSTRAINT "saved_templates_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
