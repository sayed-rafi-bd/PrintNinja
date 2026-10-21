-- CreateTable
CREATE TABLE "sample_datasets" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "data_json" TEXT NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "change_seq" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sample_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "printer_profiles" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "printer_name" TEXT NOT NULL,
    "settings_json" TEXT NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "change_seq" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "printer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "change_seq" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id","key")
);

-- CreateTable
CREATE TABLE "fonts" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "change_seq" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "fonts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "font_files" (
    "font_id" UUID NOT NULL,
    "bytes" BYTEA NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "font_files_pkey" PRIMARY KEY ("font_id")
);

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

-- AddForeignKey
ALTER TABLE "sample_datasets" ADD CONSTRAINT "sample_datasets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printer_profiles" ADD CONSTRAINT "printer_profiles_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fonts" ADD CONSTRAINT "fonts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "font_files" ADD CONSTRAINT "font_files_font_id_fkey" FOREIGN KEY ("font_id") REFERENCES "fonts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
