CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Enum to handle specific numbering sides (odd numbers, even numbers, or both)
CREATE TYPE side_type AS ENUM ('odd', 'even', 'both');

-- Table for the streets
CREATE TABLE streets (
    id SERIAL PRIMARY KEY,
    name CITEXT NOT NULL UNIQUE,
    neighborhood TEXT NOT NULL,
    descr TEXT,
    city TEXT DEFAULT 'Florianópolis',
    state CHAR(2) DEFAULT 'SC'
);

CREATE INDEX idx_streets_name_trgm ON streets USING GIN (name gin_trgm_ops);
CREATE INDEX idx_streets_descr_trgm ON streets USING GIN (descr gin_trgm_ops);

-- Table for ZIP codes, allowing multiple ZIP codes per street
CREATE TABLE zip_codes (
    id SERIAL PRIMARY KEY,
    street_id INTEGER NOT NULL REFERENCES streets(id) ON DELETE CASCADE,
    zip_code CHAR(9) NOT NULL,
    
    -- Constraint to enforce the Florianópolis Island ZIP code range
    -- The regex ^880[0-6][0-9]-[0-9]{3}$ strictly allows 88000-000 to 88069-999
    CONSTRAINT chk_island_zip_code CHECK (
        zip_code ~ '^880[0-6][0-9]-[0-9]{3}$'
    )
);

-- Index to speed up ZIP code searches
CREATE INDEX idx_zip_code ON zip_codes(zip_code);

-- Table for continuous number ranges allowed within a specific ZIP code
CREATE TABLE number_ranges (
    id SERIAL PRIMARY KEY,
    zip_code_id INTEGER NOT NULL REFERENCES zip_codes(id) ON DELETE CASCADE,
    start_number INTEGER, 
    end_number INTEGER,   
    side side_type DEFAULT 'both',
    
    -- Ensure the starting number is always less than or equal to the ending number
    CONSTRAINT chk_number_order CHECK (
        start_number IS NULL OR 
        end_number IS NULL OR 
        start_number <= end_number
    )
);

-- New table specifically for unique address numbers linked to a ZIP code
CREATE TABLE unique_numbers (
    id SERIAL PRIMARY KEY,
    zip_code_id INTEGER NOT NULL REFERENCES zip_codes(id) ON DELETE CASCADE,
    address_number INTEGER NOT NULL,
    description VARCHAR(255), -- Useful for identifying why this number has a specific rule (e.g., 'Hospital', 'Corporate Building')
    
    -- Prevent inserting the exact same unique number multiple times for the same ZIP code
    CONSTRAINT unq_zip_address_number UNIQUE (zip_code_id, address_number)
);


-- View com a contagem de CEPs por logradouro, usada pela aba "Logradouros"
-- para ordenar (mais CEPs primeiro) e paginar no próprio banco.
CREATE OR REPLACE VIEW streets_with_zip_count
WITH (security_invoker = true) AS
SELECT
    s.id,
    s.name,
    s.neighborhood,
    s.descr,
    COUNT(z.id)::int AS zip_count
FROM streets s
LEFT JOIN zip_codes z ON z.street_id = s.id
GROUP BY s.id, s.name, s.neighborhood, s.descr;

GRANT SELECT ON streets_with_zip_count TO anon, authenticated;

-- Row Level Security
ALTER TABLE streets ENABLE ROW LEVEL SECURITY;
ALTER TABLE zip_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_ranges ENABLE ROW LEVEL SECURITY;
ALTER TABLE unique_numbers ENABLE ROW LEVEL SECURITY;

-- streets: leitura pública, sem escrita pelo frontend
CREATE POLICY "streets_select_anon" ON streets
  FOR SELECT TO anon USING (true);

-- zip_codes / number_ranges / unique_numbers: CRUD completo pelo frontend
CREATE POLICY "zip_codes_all_anon" ON zip_codes
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "number_ranges_all_anon" ON number_ranges
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "unique_numbers_all_anon" ON unique_numbers
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- Opcional, recomendado para bases grandes: acelera buscas e a contagem
-- usada pela paginação/ordenação da aba Logradouros.
CREATE INDEX IF NOT EXISTS idx_zip_codes_street_id ON zip_codes(street_id);
CREATE INDEX IF NOT EXISTS idx_number_ranges_zip_code_id ON number_ranges(zip_code_id);
CREATE INDEX IF NOT EXISTS idx_unique_numbers_zip_code_id ON unique_numbers(zip_code_id);