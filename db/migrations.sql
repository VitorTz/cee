-- =============================================================================
-- 01. EXTENSIONS & CUSTOM TYPES
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Enum to handle specific numbering sides (odd numbers, even numbers, or both)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_type
        WHERE typname = 'side_type'
    ) THEN
        CREATE TYPE side_type AS ENUM ('odd', 'even', 'both');
    END IF;
END
$$;

-- =============================================================================
-- 02. UTILITY FUNCTIONS
-- =============================================================================

-- Create an IMMUTABLE wrapper function for unaccent
-- (PostgreSQL requires functions in GENERATED columns to be immutable)
CREATE OR REPLACE FUNCTION f_unaccent(text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT unaccent('unaccent', $1);
$$;

-- =============================================================================
-- 03. CORE TABLES, TRIGGERS & INDEXES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Streets
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS streets (
    id SERIAL PRIMARY KEY,
    name CITEXT NOT NULL UNIQUE,
    neighborhood TEXT[] NOT NULL,
    descr TEXT,
    search_text TEXT
);

CREATE OR REPLACE FUNCTION update_streets_search_text()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_text := lower(
    unaccent('unaccent',
      NEW.name || ' ' ||
      array_to_string(NEW.neighborhood, ' ') || ' ' ||
      COALESCE(NEW.descr, '')
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_update_streets_search_text
  BEFORE INSERT OR UPDATE ON streets
  FOR EACH ROW
  EXECUTE FUNCTION update_streets_search_text();

CREATE INDEX IF NOT EXISTS idx_streets_name_trgm ON streets USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_streets_descr_trgm ON streets USING GIN (descr gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_streets_search_text_trgm ON streets USING GIN (search_text gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- ZIP Codes
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zip_codes (
    id SERIAL PRIMARY KEY,
    street_id INTEGER NOT NULL REFERENCES streets(id) ON DELETE CASCADE,
    zip_code CHAR(9) NOT NULL,
    CONSTRAINT zip_codes_street_id_zip_code_key UNIQUE (street_id, zip_code),
    CONSTRAINT chk_island_zip_code CHECK (
        zip_code ~ '^880[0-6][0-9]-[0-9]{3}$'
    )
);

CREATE INDEX IF NOT EXISTS idx_zip_code ON zip_codes(zip_code);
CREATE INDEX IF NOT EXISTS idx_zip_codes_street_id ON zip_codes(street_id);

-- -----------------------------------------------------------------------------
-- Numbering Rules
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS numbering_rules (
    id SERIAL PRIMARY KEY,
    zip_code_id INTEGER NOT NULL REFERENCES zip_codes(id) ON DELETE CASCADE,
    start_number INTEGER, 
    end_number INTEGER,   
    side side_type DEFAULT 'both',
    description TEXT, -- Used for notes on unique numbers (e.g., 'Hospital') or specific ranges
    
    -- Ensure the starting number is always less than or equal to the ending number
    CONSTRAINT chk_number_order CHECK (
        start_number IS NULL OR 
        end_number IS NULL OR 
        start_number <= end_number
    ),
    CONSTRAINT numbering_rules_start_or_end_required check (((start_number is not null) or (end_number is not null)))
);

CREATE INDEX IF NOT EXISTS idx_numbering_rules_zip_code_id ON numbering_rules(zip_code_id);

-- -----------------------------------------------------------------------------
-- CEE Sectors
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cee_sectors (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,          -- e.g. 'AB', 'CD', 'EF', 'GH'
    label TEXT NOT NULL,                -- e.g. 'A/B', 'C/D'
    base_start INTEGER NOT NULL,
    base_end INTEGER NOT NULL,
    current_offset INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_cee_sector_range CHECK (base_start <= base_end)
);

INSERT INTO cee_sectors (code, label, base_start, base_end, display_order)
VALUES
    ('AB', 'A/B', 301, 306, 1),
    ('CD', 'C/D', 322, 329, 2),
    ('EF', 'E/F', 307, 321, 3),
    ('GH', 'G/H', 330, 339, 4)
ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE FUNCTION update_cee_sectors_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_cee_sectors_updated_at
  BEFORE UPDATE ON cee_sectors
  FOR EACH ROW
  EXECUTE FUNCTION update_cee_sectors_updated_at();

-- =============================================================================
-- 04. DAILY OPERATIONS TABLES & INDEXES
-- =============================================================================

CREATE TABLE IF NOT EXISTS daily_truck_arrivals (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL DEFAULT CURRENT_DATE,
    arrival_time TIME NOT NULL,
    truck_identifier TEXT,
    cdl_count INTEGER NOT NULL CHECK (cdl_count >= 0),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_daily_truck_arrivals_date ON daily_truck_arrivals(log_date);

CREATE TABLE IF NOT EXISTS daily_object_scans (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL DEFAULT CURRENT_DATE,
    scan_time TIME NOT NULL,
    station TEXT,
    object_count INTEGER NOT NULL CHECK (object_count >= 0),
    notes TEXT,
    source_type text NOT NULL DEFAULT 'manual',
    raw_text text,
    report jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT daily_object_scans_source_type_check CHECK (source_type IN ('manual', 'loec_paste'))
);
CREATE INDEX IF NOT EXISTS idx_daily_object_scans_date ON daily_object_scans(log_date);

CREATE TABLE IF NOT EXISTS daily_label_swaps (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL DEFAULT CURRENT_DATE,
    occurrence_time TIME NOT NULL,
    swap_count INTEGER NOT NULL CHECK (swap_count >= 0),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_daily_label_swaps_date ON daily_label_swaps(log_date);

CREATE TABLE IF NOT EXISTS daily_meetings (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL DEFAULT CURRENT_DATE,
    meeting_time TIME NOT NULL,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes >= 0),
    is_union BOOLEAN NOT NULL DEFAULT false,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_daily_meetings_date ON daily_meetings(log_date);

CREATE TABLE IF NOT EXISTS daily_malote_deliveries (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL DEFAULT CURRENT_DATE,
    delivery_time TIME NOT NULL,
    carteiro_name TEXT NOT NULL,
    malote_count INTEGER NOT NULL CHECK (malote_count >= 0),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_daily_malote_deliveries_date ON daily_malote_deliveries(log_date);

-- =============================================================================
-- 05. SYSTEM LOGGING & FEEDBACK
-- =============================================================================

CREATE TABLE IF NOT EXISTS bug_reports (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS street_search_logs (
    id SERIAL PRIMARY KEY,
    street_id INTEGER NOT NULL REFERENCES streets(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- 06. VIEWS & PERMISSIONS
-- =============================================================================

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

CREATE OR REPLACE VIEW stats_global_counts
WITH (security_invoker = true) AS
SELECT
    (SELECT COUNT(*) FROM streets) AS total_streets,
    (SELECT COUNT(*) FROM zip_codes) AS total_zips,
    (SELECT COUNT(*) FROM numbering_rules) AS total_rules,
    (SELECT COUNT(*) FROM streets WHERE id NOT IN (SELECT street_id FROM zip_codes)) AS streets_without_zips;

GRANT SELECT ON stats_global_counts TO anon, authenticated;

CREATE OR REPLACE VIEW stats_neighborhoods
WITH (security_invoker = true) AS
SELECT
    unnest(neighborhood) AS neighborhood_name,
    COUNT(id) AS street_count
FROM streets
GROUP BY 1
ORDER BY 2 DESC;

GRANT SELECT ON stats_neighborhoods TO anon, authenticated;

CREATE OR REPLACE VIEW top_consulted_streets
WITH (security_invoker = true) AS
SELECT 
    s.id,
    s.name,
    COUNT(l.id) AS consultation_count
FROM streets s
JOIN street_search_logs l ON s.id = l.street_id
GROUP BY s.id, s.name
ORDER BY consultation_count DESC;

GRANT SELECT ON top_consulted_streets TO anon, authenticated;

CREATE OR REPLACE VIEW daily_operation_summary
WITH (security_invoker = true) AS
SELECT
    d.log_date,
    COALESCE(t.total_trucks, 0) AS total_trucks,
    COALESCE(t.total_cdls, 0) AS total_cdls,
    COALESCE(o.total_scans, 0) AS total_scan_entries,
    COALESCE(o.total_objects, 0) AS total_objects,
    COALESCE(s.total_swap_entries, 0) AS total_swap_entries,
    COALESCE(s.total_swaps, 0) AS total_swaps,
    COALESCE(m.total_meetings, 0) AS total_meetings,
    COALESCE(m.union_meetings, 0) AS union_meetings,
    COALESCE(m.total_meeting_minutes, 0) AS total_meeting_minutes,
    COALESCE(ml.total_malote_entries, 0) AS total_malote_entries,
    COALESCE(ml.total_malotes, 0) AS total_malotes
FROM (
    SELECT log_date FROM daily_truck_arrivals
    UNION SELECT log_date FROM daily_object_scans
    UNION SELECT log_date FROM daily_label_swaps
    UNION SELECT log_date FROM daily_meetings
    UNION SELECT log_date FROM daily_malote_deliveries
) d
LEFT JOIN (
    SELECT log_date, COUNT(*) AS total_trucks, SUM(cdl_count) AS total_cdls
    FROM daily_truck_arrivals GROUP BY log_date
) t ON t.log_date = d.log_date
LEFT JOIN (
    SELECT log_date, COUNT(*) AS total_scans, SUM(object_count) AS total_objects
    FROM daily_object_scans GROUP BY log_date
) o ON o.log_date = d.log_date
LEFT JOIN (
    SELECT log_date, COUNT(*) AS total_swap_entries, SUM(swap_count) AS total_swaps
    FROM daily_label_swaps GROUP BY log_date
) s ON s.log_date = d.log_date
LEFT JOIN (
    SELECT log_date, COUNT(*) AS total_meetings,
           SUM(CASE WHEN is_union THEN 1 ELSE 0 END) AS union_meetings,
           SUM(duration_minutes) AS total_meeting_minutes
    FROM daily_meetings GROUP BY log_date
) m ON m.log_date = d.log_date
LEFT JOIN (
    SELECT log_date, COUNT(*) AS total_malote_entries, SUM(malote_count) AS total_malotes
    FROM daily_malote_deliveries GROUP BY log_date
) ml ON ml.log_date = d.log_date
ORDER BY d.log_date DESC;

GRANT SELECT ON daily_operation_summary TO anon, authenticated;

-- Create table to store daily operation notes
CREATE TABLE IF NOT EXISTS daily_operation_notes (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL UNIQUE DEFAULT CURRENT_DATE,
    notes TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reuse existing trigger function to automatically update the timestamp
CREATE TRIGGER trg_daily_operation_notes_updated_at
  BEFORE UPDATE ON daily_operation_notes
  FOR EACH ROW
  EXECUTE FUNCTION update_cee_sectors_updated_at();

-- Apply Row Level Security (RLS) policies
ALTER TABLE daily_operation_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "daily_operation_notes_all_anon" ON daily_operation_notes FOR ALL TO anon USING (true) WITH CHECK (true);

-- Function to retrieve the PostgreSQL version
CREATE OR REPLACE FUNCTION get_pg_version()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT version();
$$;

-- Grant execution permission to anonymous and authenticated users
GRANT EXECUTE ON FUNCTION get_pg_version() TO anon, authenticated;

-- =============================================================================
-- 07. ROW LEVEL SECURITY (RLS) & POLICIES
-- =============================================================================

-- Enable RLS on all applicable tables
ALTER TABLE streets ENABLE ROW LEVEL SECURITY;
ALTER TABLE zip_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE numbering_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE bug_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE street_search_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cee_sectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_truck_arrivals ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_object_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_label_swaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_malote_deliveries ENABLE ROW LEVEL SECURITY;

-- Clear any existing policies before recreation
DROP POLICY IF EXISTS "streets_all_anon" ON streets;
DROP POLICY IF EXISTS "zip_codes_all_anon" ON zip_codes;
DROP POLICY IF EXISTS "numbering_rules_all_anon" ON numbering_rules;
DROP POLICY IF EXISTS "bug_reports_insert_anon" ON bug_reports;
DROP POLICY IF EXISTS "street_search_logs_insert_anon" ON street_search_logs;
DROP POLICY IF EXISTS "street_search_logs_select_anon" ON street_search_logs;
DROP POLICY IF EXISTS "cee_sectors_all_anon" ON cee_sectors;
DROP POLICY IF EXISTS "daily_truck_arrivals_all_anon" ON daily_truck_arrivals;
DROP POLICY IF EXISTS "daily_object_scans_all_anon" ON daily_object_scans;
DROP POLICY IF EXISTS "daily_label_swaps_all_anon" ON daily_label_swaps;
DROP POLICY IF EXISTS "daily_meetings_all_anon" ON daily_meetings;
DROP POLICY IF EXISTS "daily_malote_deliveries_all_anon" ON daily_malote_deliveries;

-- Core policies
CREATE POLICY "streets_all_anon" ON streets FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "zip_codes_all_anon" ON zip_codes FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "numbering_rules_all_anon" ON numbering_rules FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "cee_sectors_all_anon" ON cee_sectors FOR ALL TO anon USING (true) WITH CHECK (true);

-- Logging & Feedback policies
CREATE POLICY "bug_reports_insert_anon" ON bug_reports FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "street_search_logs_insert_anon" ON street_search_logs FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "street_search_logs_select_anon" ON street_search_logs FOR SELECT TO anon USING (true);

-- Daily Operations policies
CREATE POLICY "daily_truck_arrivals_all_anon" ON daily_truck_arrivals FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "daily_object_scans_all_anon" ON daily_object_scans FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "daily_label_swaps_all_anon" ON daily_label_swaps FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "daily_meetings_all_anon" ON daily_meetings FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "daily_malote_deliveries_all_anon" ON daily_malote_deliveries FOR ALL TO anon USING (true) WITH CHECK (true);

