// Tests never use the production database. They use TEST_DATABASE_URL, or the local mona_dfi database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://localhost:5432/mona_dfi";
