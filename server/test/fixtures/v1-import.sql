-- E9 rehearsal fixture: generated from a real server-legacy run
-- (register x2 with scrypt passwords, 1 published + 1 private
-- template, 1 saved row). Tokens below are test-only.
CREATE TABLE users (
            id            TEXT PRIMARY KEY,
            handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
CREATE TABLE sessions (
            token_hash TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL
        );
CREATE TABLE templates (
            id          TEXT PRIMARY KEY,
            owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            summary     TEXT NOT NULL DEFAULT '',
            page_w_mm   REAL NOT NULL,
            page_h_mm   REAL NOT NULL,
            language    TEXT NOT NULL,
            body        TEXT NOT NULL,
            readme      TEXT NOT NULL DEFAULT '',
            css         TEXT NOT NULL DEFAULT '',
            use_count   INTEGER NOT NULL DEFAULT 0,
            published_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
CREATE TABLE saved_templates (
            user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
            added_at    TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, template_id)
        );
INSERT INTO users (id, handle, password_hash, created_at) VALUES ('bf75a279-1a34-4207-b0a1-4303a4c8bc3d', 'Rafi', '$scrypt$ln=17,r=8,p=1$tgZdlQrKjE9ViF4JJ+EikA$ITkEnIeKANMssQateZBsecz6Ui9ylasfh5T8YoSB3vw', '2026-10-20 13:37:10');
INSERT INTO users (id, handle, password_hash, created_at) VALUES ('83cfa7d9-ad9b-464c-a8df-8319e8caf480', 'Aiko', '$scrypt$ln=17,r=8,p=1$xayTi4d+3j3sSZ87IxA52A$sNn6aMfAfvdl8cTJ8FtX0toExp8P1Djp2kHwZW/AfGc', '2026-10-20 13:37:29');
INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('8c91875716480afc589ed92d646f18485bbf8fba67507702d390acf77250b730', 'bf75a279-1a34-4207-b0a1-4303a4c8bc3d', '2026-11-19T13:37:10.845824104+00:00');
INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('b12d1d7e3192c68ccfba3d24a175928488c97c02b8fe2c8e358705b903adc064', '83cfa7d9-ad9b-464c-a8df-8319e8caf480', '2026-11-19T13:37:29.439086713+00:00');
INSERT INTO templates (id, owner_id, name, summary, page_w_mm, page_h_mm, language, body, readme, css, use_count, published_at, updated_at) VALUES ('f4aebf12-9dd4-4532-8f1f-4f6e6851f8ad', 'bf75a279-1a34-4207-b0a1-4303a4c8bc3d', 'Shipping Label', '4x6', 101.6, 152.4, 'html', '<div>{{order.id}}</div>', 'docs', '.a{}', 0, '2026-10-20 13:37:29', '2026-10-20 13:37:29');
INSERT INTO templates (id, owner_id, name, summary, page_w_mm, page_h_mm, language, body, readme, css, use_count, published_at, updated_at) VALUES ('994ad926-e62f-441f-8fc7-649f01121a79', '83cfa7d9-ad9b-464c-a8df-8319e8caf480', 'Private Draft', '', 210, 297, 'html', '<div>draft</div>', '', '', 0, '', '2026-10-20 13:37:29');
INSERT INTO saved_templates (user_id, template_id, added_at) VALUES ('83cfa7d9-ad9b-464c-a8df-8319e8caf480', 'f4aebf12-9dd4-4532-8f1f-4f6e6851f8ad', '2026-10-20 13:37:29');
