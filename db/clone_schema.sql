

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

COMMENT ON SCHEMA "public" IS 'standard public schema';

CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "public";

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";

CREATE EXTENSION IF NOT EXISTS "unaccent" WITH SCHEMA "public";

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

CREATE TYPE "public"."app_role" AS ENUM (
    'admin',
    'supervisor',
    'carteiro'
);

ALTER TYPE "public"."app_role" OWNER TO "postgres";

CREATE TYPE "public"."employee_attendance_status" AS ENUM (
    'presente',
    'falta_justificada',
    'falta_injustificada',
    'atestado',
    'ferias',
    'folga'
);

ALTER TYPE "public"."employee_attendance_status" OWNER TO "postgres";

CREATE TYPE "public"."employee_leave_type" AS ENUM (
    'ferias',
    'atestado'
);

ALTER TYPE "public"."employee_leave_type" OWNER TO "postgres";

CREATE TYPE "public"."employee_type" AS ENUM (
    'carteiro_interno',
    'carteiro_externo',
    'terceirizado_interno',
    'terceirizado_externo',
    'motorista',
    'limpeza',
    'carteiro_emprestado'
);

ALTER TYPE "public"."employee_type" OWNER TO "postgres";

CREATE TYPE "public"."helpdesk_attachment_kind" AS ENUM (
    'image',
    'video',
    'audio',
    'pdf',
    'file'
);

ALTER TYPE "public"."helpdesk_attachment_kind" OWNER TO "postgres";

CREATE TYPE "public"."helpdesk_category" AS ENUM (
    'etiqueta_trocada',
    'encomenda_faltando',
    'encomenda_errada',
    'pneu_furado',
    'acidente',
    'outro'
);

ALTER TYPE "public"."helpdesk_category" OWNER TO "postgres";

CREATE TYPE "public"."helpdesk_status" AS ENUM (
    'aberto',
    'em_andamento',
    'concluido_sucesso',
    'concluido_sem_sucesso'
);

ALTER TYPE "public"."helpdesk_status" OWNER TO "postgres";

CREATE TYPE "public"."side_type" AS ENUM (
    'odd',
    'even',
    'both'
);

ALTER TYPE "public"."side_type" OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."auth_role"() RETURNS "public"."app_role"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT role FROM user_roles WHERE user_id = auth.uid();
$$;

ALTER FUNCTION "public"."auth_role"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."can_access_helpdesk_ticket_path"("p_object_name" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_ticket_id bigint;
BEGIN
  v_ticket_id := NULLIF((storage.foldername(p_object_name))[1], '')::bigint;
  IF v_ticket_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.auth_role() IN ('admin', 'supervisor') THEN
    RETURN EXISTS (SELECT 1 FROM helpdesk_tickets WHERE id = v_ticket_id);
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM helpdesk_tickets
    WHERE id = v_ticket_id AND carteiro_id = auth.uid()
  );
EXCEPTION WHEN invalid_text_representation THEN
  RETURN false;
END;
$$;

ALTER FUNCTION "public"."can_access_helpdesk_ticket_path"("p_object_name" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."close_helpdesk_ticket"("p_ticket_id" bigint, "p_status" "text", "p_report" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF public.auth_role() NOT IN ('admin', 'supervisor') THEN
    RAISE EXCEPTION 'Apenas supervisores ou administradores podem concluir chamados.';
  END IF;

  IF p_status NOT IN ('concluido_sucesso', 'concluido_sem_sucesso') THEN
    RAISE EXCEPTION 'Status de conclusão inválido: %', p_status;
  END IF;

  UPDATE helpdesk_tickets
     SET status = p_status::helpdesk_status,
         report = NULLIF(btrim(COALESCE(p_report, '')), ''),
         closed_by = auth.uid(),
         closed_at = now()
   WHERE id = p_ticket_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chamado % não encontrado.', p_ticket_id;
  END IF;
END;
$$;

ALTER FUNCTION "public"."close_helpdesk_ticket"("p_ticket_id" bigint, "p_status" "text", "p_report" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."f_unaccent"("text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $_$
  SELECT unaccent('unaccent', $1);
$_$;

ALTER FUNCTION "public"."f_unaccent"("text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."flush_client_metrics"("metrics" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    INSERT INTO global_api_logs (method, endpoint, status, duration_ms)
    SELECT 
        (elem->>'method')::text,
        (elem->>'endpoint')::text,
        (elem->>'status')::integer,
        (elem->>'durationMs')::integer
    FROM jsonb_array_elements(metrics) AS elem;
END;
$$;

ALTER FUNCTION "public"."flush_client_metrics"("metrics" "jsonb") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_dashboard_statistics"() RETURNS "jsonb"
    LANGUAGE "sql"
    AS $$
    SELECT jsonb_build_object(
        'globalData', (
            SELECT to_jsonb(g.*) 
            FROM stats_global_counts g
        ),
        
        'qualityData', (
            SELECT to_jsonb(q.*) 
            FROM stats_data_quality q
        ),
        
        'missingZipsData', COALESCE((
            SELECT jsonb_agg(mz.*) 
            FROM (SELECT name, neighborhood FROM stats_streets_missing_zips LIMIT 10) mz
        ), '[]'::jsonb),
        
        'missingRulesData', COALESCE((
            SELECT jsonb_agg(mr.*) 
            FROM (SELECT zip_code, street_name FROM stats_zips_missing_rules LIMIT 10) mr
        ), '[]'::jsonb),
        
        'neighborhoodData', COALESCE((
            SELECT jsonb_agg(nd.*) 
            FROM (SELECT * FROM stats_neighborhoods LIMIT 10) nd
        ), '[]'::jsonb),
        
        'topStreetsData', COALESCE((
            SELECT jsonb_agg(ts.*) 
            FROM (SELECT name, zip_count FROM streets_with_zip_count ORDER BY zip_count DESC NULLS LAST LIMIT 10) ts
        ), '[]'::jsonb),
        
        'topConsultedData', COALESCE((
            SELECT jsonb_agg(tc.*) 
            FROM (SELECT name, consultation_count FROM top_consulted_streets ORDER BY consultation_count DESC NULLS LAST LIMIT 10) tc
        ), '[]'::jsonb)
    );
$$;

ALTER FUNCTION "public"."get_dashboard_statistics"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_global_metrics_24h"() RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
    WITH stats AS (
        SELECT 
            COUNT(*) as total_reqs,
            COALESCE(SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END), 0) as success_reqs,
            COALESCE(ROUND(AVG(duration_ms)), 0) as avg_time,
            
            -- Track requests and timing specifically for the last 1 hour
            COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '1 hour' THEN 1 ELSE 0 END), 0) as reqs_last_hour,
            MIN(CASE WHEN created_at >= NOW() - INTERVAL '1 hour' THEN created_at END) as first_log_last_hour
        FROM global_api_logs
        WHERE created_at >= NOW() - INTERVAL '24 hours'
    )
    SELECT jsonb_build_object(
        'totalRequests', total_reqs,
        'successfulRequests', success_reqs,
        'averageResponseTimeMs', avg_time,
        
        -- Calculate requests per minute based ONLY on the last 1 hour of activity
        'requestsPerMinute', CASE 
            WHEN reqs_last_hour = 0 THEN 0
            ELSE ROUND((reqs_last_hour / GREATEST(EXTRACT(EPOCH FROM (NOW() - first_log_last_hour))/60, 1))::numeric, 2)
        END,
        
        'statusCodes', COALESCE((SELECT jsonb_object_agg(status, count) FROM (SELECT status, COUNT(*) FROM global_api_logs WHERE created_at >= NOW() - INTERVAL '24 hours' GROUP BY status) s), '{}'::jsonb),
        'methods', COALESCE((SELECT jsonb_object_agg(method, count) FROM (SELECT method, COUNT(*) FROM global_api_logs WHERE created_at >= NOW() - INTERVAL '24 hours' GROUP BY method) m), '{}'::jsonb),
        
        -- Aggregate the top 10 most heavily hit endpoints in the last 24h
        'topEndpoints', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('endpoint', endpoint, 'count', count)) 
            FROM (
                SELECT endpoint, COUNT(*) 
                FROM global_api_logs 
                WHERE created_at >= NOW() - INTERVAL '24 hours' 
                GROUP BY endpoint 
                ORDER BY count DESC 
                LIMIT 10
            ) t
        ), '[]'::jsonb)
    )
    FROM stats;
$$;

ALTER FUNCTION "public"."get_global_metrics_24h"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_helpdesk_user_labels"("p_user_ids" "uuid"[]) RETURNS TABLE("user_id" "uuid", "email" "text", "role" "public"."app_role", "full_name" "text", "phone" "text", "contact_email" "text", "address_zip" "text", "address_street" "text", "address_number" "text", "address_complement" "text", "address_neighborhood" "text", "address_city" "text", "address_state" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    u.id,
    u.email::text,
    ur.role,
    p.full_name,
    p.phone,
    p.contact_email,
    p.address_zip,
    p.address_street,
    p.address_number,
    p.address_complement,
    p.address_neighborhood,
    p.address_city,
    p.address_state
  FROM auth.users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN user_profiles p ON p.user_id = u.id
  WHERE u.id = ANY (p_user_ids);
$$;

ALTER FUNCTION "public"."get_helpdesk_user_labels"("p_user_ids" "uuid"[]) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_pg_version"() RETURNS "text"
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT version();
$$;

ALTER FUNCTION "public"."get_pg_version"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."handle_new_helpdesk_message"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.sender_role IN ('admin', 'supervisor') THEN
    INSERT INTO helpdesk_ticket_supervisors (ticket_id, supervisor_id)
    VALUES (NEW.ticket_id, NEW.sender_id)
    ON CONFLICT (ticket_id, supervisor_id) DO NOTHING;

    UPDATE helpdesk_tickets
       SET status = 'em_andamento'
     WHERE id = NEW.ticket_id
       AND status = 'aberto';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."handle_new_helpdesk_message"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$BEGIN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'carteiro')
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;$$;

ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."reopen_helpdesk_ticket"("p_ticket_id" bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF public.auth_role() NOT IN ('admin', 'supervisor') THEN
    RAISE EXCEPTION 'Apenas supervisores ou administradores podem reabrir chamados.';
  END IF;

  UPDATE helpdesk_tickets
     SET status = 'em_andamento',
         closed_by = NULL,
         closed_at = NULL
   WHERE id = p_ticket_id;
END;
$$;

ALTER FUNCTION "public"."reopen_helpdesk_ticket"("p_ticket_id" bigint) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."touch_employee_attendance_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."touch_employee_attendance_updated_at"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."touch_employee_calendar_events_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."touch_employee_calendar_events_updated_at"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."touch_employee_leaves_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."touch_employee_leaves_updated_at"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."touch_employees_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."touch_employees_updated_at"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."touch_helpdesk_ticket_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."touch_helpdesk_ticket_updated_at"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."touch_user_profiles_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."touch_user_profiles_updated_at"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."update_cee_sectors_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."update_cee_sectors_updated_at"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."update_streets_search_text"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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
$$;

ALTER FUNCTION "public"."update_streets_search_text"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."upsert_numbering_rule"("p_id" integer, "p_zip_code_id" integer, "p_start_number" integer, "p_end_number" integer, "p_side" "text", "p_description" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$BEGIN
   
    IF p_id IS NOT NULL THEN
        UPDATE numbering_rules
        SET zip_code_id = p_zip_code_id,
            start_number = p_start_number,
            end_number = p_end_number,
            side = p_side::side_type,
            description = p_description
        WHERE id = p_id;
    ELSE
        INSERT INTO numbering_rules (zip_code_id, start_number, end_number, side, description)
        VALUES (p_zip_code_id, p_start_number, p_end_number, p_side::side_type, p_description)
        ON CONFLICT (zip_code_id, side, COALESCE(start_number, -1), COALESCE(end_number, -1))
        DO UPDATE SET
            description = EXCLUDED.description;
    END IF;
END;$$;

ALTER FUNCTION "public"."upsert_numbering_rule"("p_id" integer, "p_zip_code_id" integer, "p_start_number" integer, "p_end_number" integer, "p_side" "text", "p_description" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";

CREATE TABLE IF NOT EXISTS "public"."bug_reports" (
    "id" integer NOT NULL,
    "title" "text" NOT NULL,
    "description" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "browser_info" "text"
);

ALTER TABLE "public"."bug_reports" OWNER TO "postgres";

CREATE SEQUENCE IF NOT EXISTS "public"."bug_reports_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."bug_reports_id_seq" OWNER TO "postgres";

ALTER SEQUENCE "public"."bug_reports_id_seq" OWNED BY "public"."bug_reports"."id";

CREATE TABLE IF NOT EXISTS "public"."cee_sectors" (
    "id" integer NOT NULL,
    "code" "text" NOT NULL,
    "label" "text" NOT NULL,
    "base_start" integer NOT NULL,
    "base_end" integer NOT NULL,
    "current_offset" integer DEFAULT 0 NOT NULL,
    "display_order" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "chk_cee_sector_range" CHECK (("base_start" <= "base_end"))
);

ALTER TABLE "public"."cee_sectors" OWNER TO "postgres";

CREATE SEQUENCE IF NOT EXISTS "public"."cee_sectors_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."cee_sectors_id_seq" OWNER TO "postgres";

ALTER SEQUENCE "public"."cee_sectors_id_seq" OWNED BY "public"."cee_sectors"."id";

CREATE TABLE IF NOT EXISTS "public"."contact_messages" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "subject" "text" NOT NULL,
    "message" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "attachments" "text"[] DEFAULT '{}'::"text"[]
);

ALTER TABLE "public"."contact_messages" OWNER TO "postgres";

ALTER TABLE "public"."contact_messages" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."contact_messages_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."daily_malote_deliveries" (
    "id" integer NOT NULL,
    "log_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "delivery_time" time without time zone NOT NULL,
    "carteiro_name" "text",
    "malote_count" integer NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "source_type" "text" DEFAULT 'manual'::"text" NOT NULL,
    "raw_text" "text",
    "report" "jsonb",
    CONSTRAINT "daily_malote_deliveries_malote_count_check" CHECK (("malote_count" >= 0)),
    CONSTRAINT "daily_malote_deliveries_source_type_check" CHECK (("source_type" = ANY (ARRAY['manual'::"text", 'malote_paste'::"text"])))
);

ALTER TABLE "public"."daily_malote_deliveries" OWNER TO "postgres";

COMMENT ON COLUMN "public"."daily_malote_deliveries"."source_type" IS 'manual = registrado pelo formulário "+ Registrar Malote"; malote_paste = registrado via "+ Colar Malotes"';

COMMENT ON COLUMN "public"."daily_malote_deliveries"."raw_text" IS 'Texto original colado pelo usuário no formulário "+ Colar Malotes" (somente quando source_type = malote_paste)';

COMMENT ON COLUMN "public"."daily_malote_deliveries"."report" IS 'Relatório completo (totais + detalhamento por SE) calculado no momento da colagem, somente quando source_type = malote_paste';

CREATE SEQUENCE IF NOT EXISTS "public"."daily_malote_deliveries_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."daily_malote_deliveries_id_seq" OWNER TO "postgres";

ALTER SEQUENCE "public"."daily_malote_deliveries_id_seq" OWNED BY "public"."daily_malote_deliveries"."id";

CREATE TABLE IF NOT EXISTS "public"."daily_object_scans" (
    "id" integer NOT NULL,
    "log_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "scan_time" time without time zone NOT NULL,
    "station" "text",
    "object_count" integer NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "source_type" "text" DEFAULT 'manual'::"text" NOT NULL,
    "raw_text" "text",
    "report" "jsonb",
    CONSTRAINT "daily_object_scans_object_count_check" CHECK (("object_count" >= 0)),
    CONSTRAINT "daily_object_scans_source_type_check" CHECK (("source_type" = ANY (ARRAY['manual'::"text", 'loec_paste'::"text"])))
);

ALTER TABLE "public"."daily_object_scans" OWNER TO "postgres";

COMMENT ON COLUMN "public"."daily_object_scans"."source_type" IS 'manual = registrado pelo formulário "+ Registrar LOECs"; loec_paste = registrado via "+ Colar LOECs"';

COMMENT ON COLUMN "public"."daily_object_scans"."raw_text" IS 'Texto original colado pelo usuário no formulário "+ Colar LOECs" (somente quando source_type = loec_paste)';

COMMENT ON COLUMN "public"."daily_object_scans"."report" IS 'Relatório completo (totais gerais + detalhamento por setor CEE) calculado no momento da colagem da LOEC, somente quando source_type = loec_paste';

CREATE SEQUENCE IF NOT EXISTS "public"."daily_object_scans_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."daily_object_scans_id_seq" OWNER TO "postgres";

ALTER SEQUENCE "public"."daily_object_scans_id_seq" OWNED BY "public"."daily_object_scans"."id";

CREATE TABLE IF NOT EXISTS "public"."daily_operation_notes" (
    "id" integer NOT NULL,
    "log_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "notes" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);

ALTER TABLE "public"."daily_operation_notes" OWNER TO "postgres";

CREATE SEQUENCE IF NOT EXISTS "public"."daily_operation_notes_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."daily_operation_notes_id_seq" OWNER TO "postgres";

ALTER SEQUENCE "public"."daily_operation_notes_id_seq" OWNED BY "public"."daily_operation_notes"."id";

CREATE TABLE IF NOT EXISTS "public"."daily_truck_arrivals" (
    "id" integer NOT NULL,
    "log_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "arrival_time" time without time zone NOT NULL,
    "truck_identifier" "text",
    "cdl_count" integer NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "daily_truck_arrivals_cdl_count_check" CHECK (("cdl_count" >= 0))
);

ALTER TABLE "public"."daily_truck_arrivals" OWNER TO "postgres";

CREATE OR REPLACE VIEW "public"."daily_operation_summary" WITH ("security_invoker"='true') AS
 SELECT "d"."log_date",
    COALESCE("t"."total_trucks", (0)::bigint) AS "total_trucks",
    COALESCE("t"."total_cdls", (0)::bigint) AS "total_cdls",
    COALESCE("o"."total_scans", (0)::bigint) AS "total_scan_entries",
    COALESCE("o"."total_objects", (0)::bigint) AS "total_objects",
    COALESCE("ml"."total_malote_entries", (0)::bigint) AS "total_malote_entries",
    COALESCE("ml"."total_malotes", (0)::bigint) AS "total_malotes"
   FROM (((( SELECT "daily_truck_arrivals"."log_date"
           FROM "public"."daily_truck_arrivals"
        UNION
         SELECT "daily_object_scans"."log_date"
           FROM "public"."daily_object_scans"
        UNION
         SELECT "daily_malote_deliveries"."log_date"
           FROM "public"."daily_malote_deliveries") "d"
     LEFT JOIN ( SELECT "daily_truck_arrivals"."log_date",
            "count"(*) AS "total_trucks",
            "sum"("daily_truck_arrivals"."cdl_count") AS "total_cdls"
           FROM "public"."daily_truck_arrivals"
          GROUP BY "daily_truck_arrivals"."log_date") "t" ON (("t"."log_date" = "d"."log_date")))
     LEFT JOIN ( SELECT "daily_object_scans"."log_date",
            "count"(*) AS "total_scans",
            "sum"("daily_object_scans"."object_count") AS "total_objects"
           FROM "public"."daily_object_scans"
          GROUP BY "daily_object_scans"."log_date") "o" ON (("o"."log_date" = "d"."log_date")))
     LEFT JOIN ( SELECT "daily_malote_deliveries"."log_date",
            "count"(*) AS "total_malote_entries",
            "sum"("daily_malote_deliveries"."malote_count") AS "total_malotes"
           FROM "public"."daily_malote_deliveries"
          GROUP BY "daily_malote_deliveries"."log_date") "ml" ON (("ml"."log_date" = "d"."log_date")))
  ORDER BY "d"."log_date" DESC;

ALTER VIEW "public"."daily_operation_summary" OWNER TO "postgres";

CREATE SEQUENCE IF NOT EXISTS "public"."daily_truck_arrivals_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."daily_truck_arrivals_id_seq" OWNER TO "postgres";

ALTER SEQUENCE "public"."daily_truck_arrivals_id_seq" OWNED BY "public"."daily_truck_arrivals"."id";

CREATE TABLE IF NOT EXISTS "public"."employee_attendance" (
    "id" bigint NOT NULL,
    "employee_id" bigint NOT NULL,
    "log_date" "date" NOT NULL,
    "status" "public"."employee_attendance_status" NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."employee_attendance" OWNER TO "postgres";

COMMENT ON TABLE "public"."employee_attendance" IS 'Histórico de presença diária de cada funcionário (um registro por funcionário/dia).';

ALTER TABLE "public"."employee_attendance" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."employee_attendance_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."employee_calendar_events" (
    "id" bigint NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "employee_calendar_events_date_order" CHECK (("end_date" >= "start_date")),
    CONSTRAINT "employee_calendar_events_title_not_blank" CHECK (("btrim"("title") <> ''::"text"))
);

ALTER TABLE "public"."employee_calendar_events" OWNER TO "postgres";

COMMENT ON TABLE "public"."employee_calendar_events" IS 'Eventos e lembretes livres (reuniões, treinamentos, avisos) mostrados no calendário do quadro de funcionários. Não vinculados a um funcionário específico.';

ALTER TABLE "public"."employee_calendar_events" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."employee_calendar_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."employee_leaves" (
    "id" bigint NOT NULL,
    "employee_id" bigint NOT NULL,
    "leave_type" "public"."employee_leave_type" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "reason" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "employee_leaves_date_order" CHECK (("end_date" >= "start_date"))
);

ALTER TABLE "public"."employee_leaves" OWNER TO "postgres";

COMMENT ON TABLE "public"."employee_leaves" IS 'Períodos de férias e atestado por funcionário. reason é usado sobretudo em atestados (motivo opcional).';

COMMENT ON COLUMN "public"."employee_leaves"."reason" IS 'Motivo do atestado (opcional). Não obrigatório para férias.';

CREATE TABLE IF NOT EXISTS "public"."employees" (
    "id" bigint NOT NULL,
    "full_name" "public"."citext" NOT NULL,
    "employee_type" "public"."employee_type" DEFAULT 'carteiro_interno'::"public"."employee_type" NOT NULL,
    "email" "text",
    "phone" "text",
    "cpf" "text",
    "address" "text",
    "active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "origin_branch" "text",
    CONSTRAINT "employees_cpf_format" CHECK ((("cpf" IS NULL) OR ("cpf" ~ '^\d{11}$'::"text"))),
    CONSTRAINT "employees_email_format" CHECK ((("email" IS NULL) OR ("email" ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'::"text")))
);

ALTER TABLE "public"."employees" OWNER TO "postgres";

COMMENT ON TABLE "public"."employees" IS 'Quadro completo de funcionários: carteiros (internos/externos), terceirizados (internos/externos), motoristas e limpeza. Somente admin/supervisor têm acesso.';

COMMENT ON COLUMN "public"."employees"."cpf" IS 'Somente dígitos (11), sem máscara. Opcional.';

COMMENT ON COLUMN "public"."employees"."active" IS 'false = funcionário desligado (mantido para histórico, some das listagens padrão).';

COMMENT ON COLUMN "public"."employees"."origin_branch" IS 'Sede/unidade de origem, usado sobretudo para carteiro_emprestado (de onde ele veio ajudar).';

CREATE OR REPLACE VIEW "public"."employee_current_status" WITH ("security_invoker"='true') AS
 SELECT "e"."id" AS "employee_id",
    "e"."full_name",
    "e"."employee_type",
    "e"."active",
    "ferias"."end_date" AS "ferias_until",
    "ferias"."start_date" AS "ferias_since",
    "atestado"."end_date" AS "atestado_until",
    "atestado"."start_date" AS "atestado_since",
    "atestado"."reason" AS "atestado_reason",
        CASE
            WHEN ("atestado"."id" IS NOT NULL) THEN 'atestado'::"text"
            WHEN ("ferias"."id" IS NOT NULL) THEN 'ferias'::"text"
            ELSE 'ativo'::"text"
        END AS "current_situation"
   FROM (("public"."employees" "e"
     LEFT JOIN LATERAL ( SELECT "l"."id",
            "l"."start_date",
            "l"."end_date"
           FROM "public"."employee_leaves" "l"
          WHERE (("l"."employee_id" = "e"."id") AND ("l"."leave_type" = 'ferias'::"public"."employee_leave_type") AND ((CURRENT_DATE >= "l"."start_date") AND (CURRENT_DATE <= "l"."end_date")))
          ORDER BY "l"."end_date" DESC
         LIMIT 1) "ferias" ON (true))
     LEFT JOIN LATERAL ( SELECT "l"."id",
            "l"."start_date",
            "l"."end_date",
            "l"."reason"
           FROM "public"."employee_leaves" "l"
          WHERE (("l"."employee_id" = "e"."id") AND ("l"."leave_type" = 'atestado'::"public"."employee_leave_type") AND ((CURRENT_DATE >= "l"."start_date") AND (CURRENT_DATE <= "l"."end_date")))
          ORDER BY "l"."end_date" DESC
         LIMIT 1) "atestado" ON (true))
  WHERE ("e"."active" = true);

ALTER VIEW "public"."employee_current_status" OWNER TO "postgres";

ALTER TABLE "public"."employee_leaves" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."employee_leaves_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE OR REPLACE VIEW "public"."employee_upcoming_vacations" WITH ("security_invoker"='true') AS
 SELECT "l"."id",
    "l"."employee_id",
    "e"."full_name",
    "e"."employee_type",
    "l"."start_date",
    "l"."end_date"
   FROM ("public"."employee_leaves" "l"
     JOIN "public"."employees" "e" ON (("e"."id" = "l"."employee_id")))
  WHERE (("l"."leave_type" = 'ferias'::"public"."employee_leave_type") AND ("l"."start_date" >= CURRENT_DATE))
  ORDER BY "l"."start_date";

ALTER VIEW "public"."employee_upcoming_vacations" OWNER TO "postgres";

ALTER TABLE "public"."employees" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."employees_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."geocoding_cache" (
    "id" bigint NOT NULL,
    "zip_code" character(9) NOT NULL,
    "street_number" "text" NOT NULL,
    "lat" numeric NOT NULL,
    "lon" numeric NOT NULL,
    "formatted_address" "text",
    "location_type" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."geocoding_cache" OWNER TO "postgres";

ALTER TABLE "public"."geocoding_cache" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."geocoding_cache_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."global_api_logs" (
    "id" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "method" "text" NOT NULL,
    "endpoint" "text" NOT NULL,
    "status" integer NOT NULL,
    "duration_ms" integer NOT NULL
);

ALTER TABLE "public"."global_api_logs" OWNER TO "postgres";

CREATE SEQUENCE IF NOT EXISTS "public"."global_api_logs_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."global_api_logs_id_seq" OWNER TO "postgres";

ALTER SEQUENCE "public"."global_api_logs_id_seq" OWNED BY "public"."global_api_logs"."id";

CREATE TABLE IF NOT EXISTS "public"."helpdesk_attachments" (
    "id" bigint NOT NULL,
    "message_id" bigint NOT NULL,
    "ticket_id" bigint NOT NULL,
    "storage_path" "text" NOT NULL,
    "mime_type" "text",
    "kind" "public"."helpdesk_attachment_kind" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "original_name" "text",
    "file_size" bigint,
    "download_name" "text"
);

ALTER TABLE "public"."helpdesk_attachments" OWNER TO "postgres";

COMMENT ON COLUMN "public"."helpdesk_attachments"."original_name" IS 'Nome original do arquivo escolhido pelo usuário.';

COMMENT ON COLUMN "public"."helpdesk_attachments"."file_size" IS 'Tamanho do arquivo em bytes (limite de aplicação: 50MB).';

COMMENT ON COLUMN "public"."helpdesk_attachments"."download_name" IS 'Nome amigável usado ao baixar: chamado, carteiro, supervisor e data.';

ALTER TABLE "public"."helpdesk_attachments" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."helpdesk_attachments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."helpdesk_messages" (
    "id" bigint NOT NULL,
    "ticket_id" bigint NOT NULL,
    "sender_id" "uuid" NOT NULL,
    "sender_role" "public"."app_role" NOT NULL,
    "body" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."helpdesk_messages" OWNER TO "postgres";

ALTER TABLE "public"."helpdesk_messages" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."helpdesk_messages_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."helpdesk_ticket_supervisors" (
    "ticket_id" bigint NOT NULL,
    "supervisor_id" "uuid" NOT NULL,
    "first_message_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."helpdesk_ticket_supervisors" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."helpdesk_tickets" (
    "id" bigint NOT NULL,
    "carteiro_id" "uuid" NOT NULL,
    "category" "public"."helpdesk_category" NOT NULL,
    "title" "text" NOT NULL,
    "status" "public"."helpdesk_status" DEFAULT 'aberto'::"public"."helpdesk_status" NOT NULL,
    "report" "text",
    "closed_by" "uuid",
    "closed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."helpdesk_tickets" OWNER TO "postgres";

ALTER TABLE "public"."helpdesk_tickets" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."helpdesk_tickets_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS "public"."numbering_rules" (
    "id" integer NOT NULL,
    "zip_code_id" integer NOT NULL,
    "start_number" integer,
    "end_number" integer,
    "side" "public"."side_type" DEFAULT 'both'::"public"."side_type",
    "description" "text",
    CONSTRAINT "chk_number_order" CHECK ((("start_number" IS NULL) OR ("end_number" IS NULL) OR ("start_number" <= "end_number"))),
    CONSTRAINT "numbering_rules_start_or_end_required" CHECK ((("start_number" IS NOT NULL) OR ("end_number" IS NOT NULL)))
);

ALTER TABLE "public"."numbering_rules" OWNER TO "postgres";

CREATE SEQUENCE IF NOT EXISTS "public"."numbering_rules_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."numbering_rules_id_seq" OWNER TO "postgres";

ALTER SEQUENCE "public"."numbering_rules_id_seq" OWNED BY "public"."numbering_rules"."id";

CREATE TABLE IF NOT EXISTS "public"."streets" (
    "id" integer NOT NULL,
    "name" "public"."citext" NOT NULL,
    "neighborhood" "text"[] NOT NULL,
    "descr" "text",
    "search_text" "text"
);

ALTER TABLE "public"."streets" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."zip_codes" (
    "id" integer NOT NULL,
    "street_id" integer NOT NULL,
    "zip_code" character(9) NOT NULL,
    CONSTRAINT "chk_island_zip_code" CHECK (("zip_code" ~ '^880[0-6][0-9]-[0-9]{3}$'::"text"))
);

ALTER TABLE "public"."zip_codes" OWNER TO "postgres";

CREATE OR REPLACE VIEW "public"."stats_data_quality" WITH ("security_invoker"='true') AS
 SELECT ( SELECT "count"(*) AS "count"
           FROM ("public"."streets" "s"
             LEFT JOIN "public"."zip_codes" "z" ON (("z"."street_id" = "s"."id")))
          WHERE ("z"."id" IS NULL)) AS "streets_missing_zips",
    ( SELECT "count"(*) AS "count"
           FROM ("public"."zip_codes" "z"
             LEFT JOIN "public"."numbering_rules" "nr" ON (("nr"."zip_code_id" = "z"."id")))
          WHERE ("nr"."id" IS NULL)) AS "zips_missing_rules";

ALTER VIEW "public"."stats_data_quality" OWNER TO "postgres";

CREATE OR REPLACE VIEW "public"."stats_global_counts" WITH ("security_invoker"='true') AS
 SELECT ( SELECT "count"(*) AS "count"
           FROM "public"."streets") AS "total_streets",
    ( SELECT "count"(*) AS "count"
           FROM "public"."zip_codes") AS "total_zips",
    ( SELECT "count"(*) AS "count"
           FROM "public"."numbering_rules") AS "total_rules",
    ( SELECT "count"(*) AS "count"
           FROM "public"."streets"
          WHERE (NOT ("streets"."id" IN ( SELECT "zip_codes"."street_id"
                   FROM "public"."zip_codes")))) AS "streets_without_zips";

ALTER VIEW "public"."stats_global_counts" OWNER TO "postgres";

CREATE OR REPLACE VIEW "public"."stats_neighborhoods" WITH ("security_invoker"='true') AS
 SELECT "unnest"("neighborhood") AS "neighborhood_name",
    "count"("id") AS "street_count"
   FROM "public"."streets"
  GROUP BY ("unnest"("neighborhood"))
  ORDER BY ("count"("id")) DESC;

ALTER VIEW "public"."stats_neighborhoods" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."street_search_logs" (
    "id" integer NOT NULL,
    "street_id" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);

ALTER TABLE "public"."street_search_logs" OWNER TO "postgres";

CREATE OR REPLACE VIEW "public"."stats_search_activity_daily" WITH ("security_invoker"='true') AS
 SELECT ("created_at")::"date" AS "search_date",
    "count"(*) AS "search_count"
   FROM "public"."street_search_logs"
  GROUP BY (("created_at")::"date")
  ORDER BY (("created_at")::"date") DESC;

ALTER VIEW "public"."stats_search_activity_daily" OWNER TO "postgres";

CREATE OR REPLACE VIEW "public"."stats_streets_missing_zips" WITH ("security_invoker"='true') AS
 SELECT "s"."id",
    "s"."name",
    "s"."neighborhood"
   FROM ("public"."streets" "s"
     LEFT JOIN "public"."zip_codes" "z" ON (("z"."street_id" = "s"."id")))
  WHERE ("z"."id" IS NULL)
  ORDER BY "s"."name";

ALTER VIEW "public"."stats_streets_missing_zips" OWNER TO "postgres";

CREATE OR REPLACE VIEW "public"."stats_zips_missing_rules" WITH ("security_invoker"='true') AS
 SELECT "z"."id",
    "z"."zip_code",
    "s"."name" AS "street_name"
   FROM (("public"."zip_codes" "z"
     JOIN "public"."streets" "s" ON (("s"."id" = "z"."street_id")))
     LEFT JOIN "public"."numbering_rules" "nr" ON (("nr"."zip_code_id" = "z"."id")))
  WHERE ("nr"."id" IS NULL)
  ORDER BY "z"."zip_code";

ALTER VIEW "public"."stats_zips_missing_rules" OWNER TO "postgres";

CREATE SEQUENCE IF NOT EXISTS "public"."street_search_logs_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."street_search_logs_id_seq" OWNER TO "postgres";

ALTER SEQUENCE "public"."street_search_logs_id_seq" OWNED BY "public"."street_search_logs"."id";

CREATE SEQUENCE IF NOT EXISTS "public"."streets_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."streets_id_seq" OWNER TO "postgres";

ALTER SEQUENCE "public"."streets_id_seq" OWNED BY "public"."streets"."id";

CREATE OR REPLACE VIEW "public"."streets_with_zip_count" WITH ("security_invoker"='true') AS
 SELECT "s"."id",
    "s"."name",
    "s"."neighborhood",
    "s"."descr",
    ("count"("z"."id"))::integer AS "zip_count"
   FROM ("public"."streets" "s"
     LEFT JOIN "public"."zip_codes" "z" ON (("z"."street_id" = "s"."id")))
  GROUP BY "s"."id", "s"."name", "s"."neighborhood", "s"."descr";

ALTER VIEW "public"."streets_with_zip_count" OWNER TO "postgres";

CREATE OR REPLACE VIEW "public"."top_consulted_streets" WITH ("security_invoker"='true') AS
 SELECT "s"."id",
    "s"."name",
    "count"("l"."id") AS "consultation_count"
   FROM ("public"."streets" "s"
     JOIN "public"."street_search_logs" "l" ON (("s"."id" = "l"."street_id")))
  GROUP BY "s"."id", "s"."name"
  ORDER BY ("count"("l"."id")) DESC;

ALTER VIEW "public"."top_consulted_streets" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "user_id" "uuid" NOT NULL,
    "full_name" "text",
    "phone" "text",
    "contact_email" "text",
    "address_zip" "text",
    "address_street" "text",
    "address_number" "text",
    "address_complement" "text",
    "address_neighborhood" "text",
    "address_city" "text",
    "address_state" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."user_profiles" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "user_id" "uuid" NOT NULL,
    "role" "public"."app_role" DEFAULT 'carteiro'::"public"."app_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);

ALTER TABLE "public"."user_roles" OWNER TO "postgres";

CREATE SEQUENCE IF NOT EXISTS "public"."zip_codes_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."zip_codes_id_seq" OWNER TO "postgres";

ALTER SEQUENCE "public"."zip_codes_id_seq" OWNED BY "public"."zip_codes"."id";

ALTER TABLE ONLY "public"."bug_reports" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."bug_reports_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."cee_sectors" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cee_sectors_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."daily_malote_deliveries" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."daily_malote_deliveries_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."daily_object_scans" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."daily_object_scans_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."daily_operation_notes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."daily_operation_notes_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."daily_truck_arrivals" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."daily_truck_arrivals_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."global_api_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."global_api_logs_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."numbering_rules" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."numbering_rules_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."street_search_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."street_search_logs_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."streets" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."streets_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."zip_codes" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."zip_codes_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."bug_reports"
    ADD CONSTRAINT "bug_reports_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."cee_sectors"
    ADD CONSTRAINT "cee_sectors_code_key" UNIQUE ("code");

ALTER TABLE ONLY "public"."cee_sectors"
    ADD CONSTRAINT "cee_sectors_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."contact_messages"
    ADD CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."daily_malote_deliveries"
    ADD CONSTRAINT "daily_malote_deliveries_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."daily_object_scans"
    ADD CONSTRAINT "daily_object_scans_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."daily_operation_notes"
    ADD CONSTRAINT "daily_operation_notes_log_date_key" UNIQUE ("log_date");

ALTER TABLE ONLY "public"."daily_operation_notes"
    ADD CONSTRAINT "daily_operation_notes_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."daily_truck_arrivals"
    ADD CONSTRAINT "daily_truck_arrivals_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."employee_attendance"
    ADD CONSTRAINT "employee_attendance_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."employee_attendance"
    ADD CONSTRAINT "employee_attendance_unique_day" UNIQUE ("employee_id", "log_date");

ALTER TABLE ONLY "public"."employee_calendar_events"
    ADD CONSTRAINT "employee_calendar_events_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."employee_leaves"
    ADD CONSTRAINT "employee_leaves_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."geocoding_cache"
    ADD CONSTRAINT "geocoding_cache_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."global_api_logs"
    ADD CONSTRAINT "global_api_logs_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."helpdesk_attachments"
    ADD CONSTRAINT "helpdesk_attachments_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."helpdesk_messages"
    ADD CONSTRAINT "helpdesk_messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."helpdesk_ticket_supervisors"
    ADD CONSTRAINT "helpdesk_ticket_supervisors_pkey" PRIMARY KEY ("ticket_id", "supervisor_id");

ALTER TABLE ONLY "public"."helpdesk_tickets"
    ADD CONSTRAINT "helpdesk_tickets_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."numbering_rules"
    ADD CONSTRAINT "numbering_rules_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."street_search_logs"
    ADD CONSTRAINT "street_search_logs_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."streets"
    ADD CONSTRAINT "streets_name_key" UNIQUE ("name");

ALTER TABLE ONLY "public"."streets"
    ADD CONSTRAINT "streets_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."geocoding_cache"
    ADD CONSTRAINT "unique_address_query" UNIQUE ("zip_code", "street_number");

ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id");

ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id");

ALTER TABLE ONLY "public"."zip_codes"
    ADD CONSTRAINT "zip_codes_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."zip_codes"
    ADD CONSTRAINT "zip_codes_street_id_zip_code_key" UNIQUE ("street_id", "zip_code");

CREATE INDEX "employee_attendance_employee_idx" ON "public"."employee_attendance" USING "btree" ("employee_id");

CREATE INDEX "employee_attendance_log_date_idx" ON "public"."employee_attendance" USING "btree" ("log_date");

CREATE INDEX "employee_calendar_events_range_idx" ON "public"."employee_calendar_events" USING "btree" ("start_date", "end_date");

CREATE INDEX "employee_leaves_employee_idx" ON "public"."employee_leaves" USING "btree" ("employee_id");

CREATE INDEX "employee_leaves_range_idx" ON "public"."employee_leaves" USING "btree" ("leave_type", "start_date", "end_date");

CREATE INDEX "employees_active_idx" ON "public"."employees" USING "btree" ("active");

CREATE UNIQUE INDEX "employees_cpf_unique_idx" ON "public"."employees" USING "btree" ("cpf") WHERE ("cpf" IS NOT NULL);

CREATE INDEX "employees_full_name_idx" ON "public"."employees" USING "btree" ("full_name");

CREATE INDEX "employees_type_idx" ON "public"."employees" USING "btree" ("employee_type");

CREATE INDEX "helpdesk_attachments_message_idx" ON "public"."helpdesk_attachments" USING "btree" ("message_id");

CREATE INDEX "helpdesk_attachments_ticket_idx" ON "public"."helpdesk_attachments" USING "btree" ("ticket_id");

CREATE INDEX "helpdesk_messages_ticket_idx" ON "public"."helpdesk_messages" USING "btree" ("ticket_id", "created_at");

CREATE INDEX "helpdesk_tickets_carteiro_idx" ON "public"."helpdesk_tickets" USING "btree" ("carteiro_id");

CREATE INDEX "helpdesk_tickets_status_idx" ON "public"."helpdesk_tickets" USING "btree" ("status");

CREATE INDEX "idx_daily_malote_deliveries_date" ON "public"."daily_malote_deliveries" USING "btree" ("log_date");

CREATE INDEX "idx_daily_object_scans_date" ON "public"."daily_object_scans" USING "btree" ("log_date");

CREATE INDEX "idx_daily_truck_arrivals_date" ON "public"."daily_truck_arrivals" USING "btree" ("log_date");

CREATE INDEX "idx_geocoding_cache_lookup" ON "public"."geocoding_cache" USING "btree" ("zip_code", "street_number");

CREATE INDEX "idx_numbering_rules_zip_code_id" ON "public"."numbering_rules" USING "btree" ("zip_code_id");

CREATE INDEX "idx_street_search_logs_created_at" ON "public"."street_search_logs" USING "btree" ("created_at");

CREATE INDEX "idx_streets_descr_trgm" ON "public"."streets" USING "gin" ("descr" "public"."gin_trgm_ops");

CREATE INDEX "idx_streets_name_trgm" ON "public"."streets" USING "gin" ("name" "public"."gin_trgm_ops");

CREATE INDEX "idx_streets_search_text_trgm" ON "public"."streets" USING "gin" ("search_text" "public"."gin_trgm_ops");

CREATE UNIQUE INDEX "idx_unique_rule" ON "public"."numbering_rules" USING "btree" ("zip_code_id", "side", COALESCE("start_number", '-1'::integer), COALESCE("end_number", '-1'::integer));

CREATE INDEX "idx_zip_code" ON "public"."zip_codes" USING "btree" ("zip_code");

CREATE INDEX "idx_zip_codes_street_id" ON "public"."zip_codes" USING "btree" ("street_id");

CREATE OR REPLACE TRIGGER "helpdesk_messages_after_insert" AFTER INSERT ON "public"."helpdesk_messages" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_helpdesk_message"();

CREATE OR REPLACE TRIGGER "helpdesk_tickets_touch_updated_at" BEFORE UPDATE ON "public"."helpdesk_tickets" FOR EACH ROW EXECUTE FUNCTION "public"."touch_helpdesk_ticket_updated_at"();

CREATE OR REPLACE TRIGGER "trg_cee_sectors_updated_at" BEFORE UPDATE ON "public"."cee_sectors" FOR EACH ROW EXECUTE FUNCTION "public"."update_cee_sectors_updated_at"();

CREATE OR REPLACE TRIGGER "trg_daily_operation_notes_updated_at" BEFORE UPDATE ON "public"."daily_operation_notes" FOR EACH ROW EXECUTE FUNCTION "public"."update_cee_sectors_updated_at"();

CREATE OR REPLACE TRIGGER "trg_employee_attendance_touch_updated_at" BEFORE UPDATE ON "public"."employee_attendance" FOR EACH ROW EXECUTE FUNCTION "public"."touch_employee_attendance_updated_at"();

CREATE OR REPLACE TRIGGER "trg_employee_calendar_events_touch_updated_at" BEFORE UPDATE ON "public"."employee_calendar_events" FOR EACH ROW EXECUTE FUNCTION "public"."touch_employee_calendar_events_updated_at"();

CREATE OR REPLACE TRIGGER "trg_employee_leaves_touch_updated_at" BEFORE UPDATE ON "public"."employee_leaves" FOR EACH ROW EXECUTE FUNCTION "public"."touch_employee_leaves_updated_at"();

CREATE OR REPLACE TRIGGER "trg_employees_touch_updated_at" BEFORE UPDATE ON "public"."employees" FOR EACH ROW EXECUTE FUNCTION "public"."touch_employees_updated_at"();

CREATE OR REPLACE TRIGGER "trg_update_streets_search_text" BEFORE INSERT OR UPDATE ON "public"."streets" FOR EACH ROW EXECUTE FUNCTION "public"."update_streets_search_text"();

CREATE OR REPLACE TRIGGER "trg_user_profiles_updated_at" BEFORE UPDATE ON "public"."user_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."touch_user_profiles_updated_at"();

ALTER TABLE ONLY "public"."contact_messages"
    ADD CONSTRAINT "contact_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."employee_attendance"
    ADD CONSTRAINT "employee_attendance_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."employee_attendance"
    ADD CONSTRAINT "employee_attendance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."employee_calendar_events"
    ADD CONSTRAINT "employee_calendar_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."employee_leaves"
    ADD CONSTRAINT "employee_leaves_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."employee_leaves"
    ADD CONSTRAINT "employee_leaves_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."helpdesk_attachments"
    ADD CONSTRAINT "helpdesk_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."helpdesk_messages"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."helpdesk_attachments"
    ADD CONSTRAINT "helpdesk_attachments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."helpdesk_tickets"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."helpdesk_messages"
    ADD CONSTRAINT "helpdesk_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."helpdesk_messages"
    ADD CONSTRAINT "helpdesk_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."helpdesk_tickets"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."helpdesk_ticket_supervisors"
    ADD CONSTRAINT "helpdesk_ticket_supervisors_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."helpdesk_ticket_supervisors"
    ADD CONSTRAINT "helpdesk_ticket_supervisors_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."helpdesk_tickets"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."helpdesk_tickets"
    ADD CONSTRAINT "helpdesk_tickets_carteiro_id_fkey" FOREIGN KEY ("carteiro_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."helpdesk_tickets"
    ADD CONSTRAINT "helpdesk_tickets_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "auth"."users"("id");

ALTER TABLE ONLY "public"."numbering_rules"
    ADD CONSTRAINT "numbering_rules_zip_code_id_fkey" FOREIGN KEY ("zip_code_id") REFERENCES "public"."zip_codes"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."street_search_logs"
    ADD CONSTRAINT "street_search_logs_street_id_fkey" FOREIGN KEY ("street_id") REFERENCES "public"."streets"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."zip_codes"
    ADD CONSTRAINT "zip_codes_street_id_fkey" FOREIGN KEY ("street_id") REFERENCES "public"."streets"("id") ON DELETE CASCADE;

CREATE POLICY "Admins can view contact messages" ON "public"."contact_messages" FOR SELECT TO "authenticated" USING (("public"."auth_role"() = 'admin'::"public"."app_role"));

CREATE POLICY "Allow authenticated users to insert geocoding cache" ON "public"."geocoding_cache" FOR INSERT TO "authenticated" WITH CHECK (true);

CREATE POLICY "Allow authenticated users to insert telemetry" ON "public"."global_api_logs" FOR INSERT TO "authenticated" WITH CHECK (true);

CREATE POLICY "Allow authenticated users to select geocoding cache" ON "public"."geocoding_cache" FOR SELECT TO "authenticated" USING (true);

CREATE POLICY "Enable read access for all users" ON "public"."cee_sectors" FOR SELECT USING (true);

CREATE POLICY "Street Search all" ON "public"."street_search_logs" USING (true) WITH CHECK (true);

CREATE POLICY "Users can insert their own contact messages" ON "public"."contact_messages" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."bug_reports" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bug_reports_insert_auth" ON "public"."bug_reports" FOR INSERT TO "authenticated" WITH CHECK (true);

ALTER TABLE "public"."cee_sectors" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cee_sectors_write_admin_supervisor" ON "public"."cee_sectors" TO "authenticated" USING (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"]))) WITH CHECK (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])));

ALTER TABLE "public"."contact_messages" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."daily_malote_deliveries" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_malote_deliveries_select_auth" ON "public"."daily_malote_deliveries" FOR SELECT TO "authenticated" USING (true);

CREATE POLICY "daily_malote_deliveries_write_ops" ON "public"."daily_malote_deliveries" TO "authenticated" USING (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"]))) WITH CHECK (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])));

ALTER TABLE "public"."daily_object_scans" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_object_scans_select_auth" ON "public"."daily_object_scans" FOR SELECT TO "authenticated" USING (true);

CREATE POLICY "daily_object_scans_write_ops" ON "public"."daily_object_scans" TO "authenticated" USING (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"]))) WITH CHECK (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])));

ALTER TABLE "public"."daily_operation_notes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_operation_notes_select_auth" ON "public"."daily_operation_notes" FOR SELECT TO "authenticated" USING (true);

CREATE POLICY "daily_operation_notes_write_ops" ON "public"."daily_operation_notes" TO "authenticated" USING (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"]))) WITH CHECK (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])));

ALTER TABLE "public"."daily_truck_arrivals" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_truck_arrivals_select_auth" ON "public"."daily_truck_arrivals" FOR SELECT TO "authenticated" USING (true);

CREATE POLICY "daily_truck_arrivals_write_ops" ON "public"."daily_truck_arrivals" TO "authenticated" USING (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"]))) WITH CHECK (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])));

ALTER TABLE "public"."employee_attendance" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_attendance_admin_supervisor_only" ON "public"."employee_attendance" TO "authenticated" USING (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"]))) WITH CHECK (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])));

ALTER TABLE "public"."employee_calendar_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_calendar_events_admin_supervisor_only" ON "public"."employee_calendar_events" TO "authenticated" USING (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"]))) WITH CHECK (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])));

ALTER TABLE "public"."employee_leaves" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_leaves_admin_supervisor_only" ON "public"."employee_leaves" TO "authenticated" USING (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"]))) WITH CHECK (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])));

ALTER TABLE "public"."employees" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employees_admin_supervisor_only" ON "public"."employees" TO "authenticated" USING (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"]))) WITH CHECK (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])));

ALTER TABLE "public"."geocoding_cache" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."global_api_logs" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."helpdesk_attachments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "helpdesk_attachments_insert" ON "public"."helpdesk_attachments" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."helpdesk_messages" "m"
  WHERE (("m"."id" = "helpdesk_attachments"."message_id") AND ("m"."sender_id" = "auth"."uid"()) AND ("m"."ticket_id" = "helpdesk_attachments"."ticket_id")))));

CREATE POLICY "helpdesk_attachments_select" ON "public"."helpdesk_attachments" FOR SELECT TO "authenticated" USING ((("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])) OR (EXISTS ( SELECT 1
   FROM "public"."helpdesk_tickets" "t"
  WHERE (("t"."id" = "helpdesk_attachments"."ticket_id") AND ("t"."carteiro_id" = "auth"."uid"()))))));

ALTER TABLE "public"."helpdesk_messages" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "helpdesk_messages_insert" ON "public"."helpdesk_messages" FOR INSERT TO "authenticated" WITH CHECK ((("sender_id" = "auth"."uid"()) AND ("sender_role" = "public"."auth_role"()) AND (EXISTS ( SELECT 1
   FROM "public"."helpdesk_tickets" "t"
  WHERE (("t"."id" = "helpdesk_messages"."ticket_id") AND ("t"."status" <> ALL (ARRAY['concluido_sucesso'::"public"."helpdesk_status", 'concluido_sem_sucesso'::"public"."helpdesk_status"])) AND (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])) OR ("t"."carteiro_id" = "auth"."uid"())))))));

CREATE POLICY "helpdesk_messages_select" ON "public"."helpdesk_messages" FOR SELECT TO "authenticated" USING ((("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])) OR (EXISTS ( SELECT 1
   FROM "public"."helpdesk_tickets" "t"
  WHERE (("t"."id" = "helpdesk_messages"."ticket_id") AND ("t"."carteiro_id" = "auth"."uid"()))))));

ALTER TABLE "public"."helpdesk_ticket_supervisors" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "helpdesk_ticket_supervisors_select" ON "public"."helpdesk_ticket_supervisors" FOR SELECT TO "authenticated" USING ((("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])) OR (EXISTS ( SELECT 1
   FROM "public"."helpdesk_tickets" "t"
  WHERE (("t"."id" = "helpdesk_ticket_supervisors"."ticket_id") AND ("t"."carteiro_id" = "auth"."uid"()))))));

ALTER TABLE "public"."helpdesk_tickets" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "helpdesk_tickets_delete" ON "public"."helpdesk_tickets" FOR DELETE TO "authenticated" USING (("public"."auth_role"() = 'admin'::"public"."app_role"));

CREATE POLICY "helpdesk_tickets_insert" ON "public"."helpdesk_tickets" FOR INSERT TO "authenticated" WITH CHECK ((("public"."auth_role"() = 'carteiro'::"public"."app_role") AND ("carteiro_id" = "auth"."uid"())));

CREATE POLICY "helpdesk_tickets_select" ON "public"."helpdesk_tickets" FOR SELECT TO "authenticated" USING ((("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])) OR ("carteiro_id" = "auth"."uid"())));

CREATE POLICY "helpdesk_tickets_update" ON "public"."helpdesk_tickets" FOR UPDATE TO "authenticated" USING (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"]))) WITH CHECK (("public"."auth_role"() = ANY (ARRAY['admin'::"public"."app_role", 'supervisor'::"public"."app_role"])));

ALTER TABLE "public"."numbering_rules" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "numbering_rules_all_access" ON "public"."numbering_rules" TO "authenticated" USING (true) WITH CHECK (true);

ALTER TABLE "public"."street_search_logs" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."streets" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "streets_all" ON "public"."streets" TO "authenticated" USING (true) WITH CHECK (true);

ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_profiles_delete_own" ON "public"."user_profiles" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));

CREATE POLICY "user_profiles_insert_own" ON "public"."user_profiles" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));

CREATE POLICY "user_profiles_select_own" ON "public"."user_profiles" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));

CREATE POLICY "user_profiles_update_own" ON "public"."user_profiles" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_roles_select_own" ON "public"."user_roles" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."zip_codes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "zip_codes_all" ON "public"."zip_codes" TO "authenticated" USING (true) WITH CHECK (true);

CREATE POLICY "zip_codes_select_auth" ON "public"."zip_codes" FOR SELECT TO "authenticated" USING (true);

ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."helpdesk_messages";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."helpdesk_tickets";

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "service_role";

GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "service_role";

GRANT ALL ON FUNCTION "public"."citext"(character) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "anon";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "service_role";

GRANT ALL ON FUNCTION "public"."citext"("inet") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "anon";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "service_role";

GRANT ALL ON FUNCTION "public"."auth_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."auth_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auth_role"() TO "service_role";

GRANT ALL ON FUNCTION "public"."can_access_helpdesk_ticket_path"("p_object_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."can_access_helpdesk_ticket_path"("p_object_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_access_helpdesk_ticket_path"("p_object_name" "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."close_helpdesk_ticket"("p_ticket_id" bigint, "p_status" "text", "p_report" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."close_helpdesk_ticket"("p_ticket_id" bigint, "p_status" "text", "p_report" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."close_helpdesk_ticket"("p_ticket_id" bigint, "p_status" "text", "p_report" "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."f_unaccent"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."f_unaccent"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."f_unaccent"("text") TO "service_role";

GRANT ALL ON FUNCTION "public"."flush_client_metrics"("metrics" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."flush_client_metrics"("metrics" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."flush_client_metrics"("metrics" "jsonb") TO "service_role";

GRANT ALL ON FUNCTION "public"."get_dashboard_statistics"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_dashboard_statistics"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_dashboard_statistics"() TO "service_role";

GRANT ALL ON FUNCTION "public"."get_global_metrics_24h"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_global_metrics_24h"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_global_metrics_24h"() TO "service_role";

GRANT ALL ON FUNCTION "public"."get_helpdesk_user_labels"("p_user_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_helpdesk_user_labels"("p_user_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_helpdesk_user_labels"("p_user_ids" "uuid"[]) TO "service_role";

GRANT ALL ON FUNCTION "public"."get_pg_version"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_pg_version"() TO "service_role";

GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."handle_new_helpdesk_message"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_helpdesk_message"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_helpdesk_message"() TO "service_role";

GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";

GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."reopen_helpdesk_ticket"("p_ticket_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."reopen_helpdesk_ticket"("p_ticket_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."reopen_helpdesk_ticket"("p_ticket_id" bigint) TO "service_role";

GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";

GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";

GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "service_role";

GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "service_role";

GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."touch_employee_attendance_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_employee_attendance_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_employee_attendance_updated_at"() TO "service_role";

GRANT ALL ON FUNCTION "public"."touch_employee_calendar_events_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_employee_calendar_events_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_employee_calendar_events_updated_at"() TO "service_role";

GRANT ALL ON FUNCTION "public"."touch_employee_leaves_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_employee_leaves_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_employee_leaves_updated_at"() TO "service_role";

GRANT ALL ON FUNCTION "public"."touch_employees_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_employees_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_employees_updated_at"() TO "service_role";

GRANT ALL ON FUNCTION "public"."touch_helpdesk_ticket_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_helpdesk_ticket_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_helpdesk_ticket_updated_at"() TO "service_role";

GRANT ALL ON FUNCTION "public"."touch_user_profiles_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_user_profiles_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_user_profiles_updated_at"() TO "service_role";

GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."unaccent"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."unaccent"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."unaccent"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unaccent"("text") TO "service_role";

GRANT ALL ON FUNCTION "public"."unaccent"("regdictionary", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."unaccent"("regdictionary", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."unaccent"("regdictionary", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unaccent"("regdictionary", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."unaccent_init"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."unaccent_init"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."unaccent_init"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unaccent_init"("internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."unaccent_lexize"("internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."unaccent_lexize"("internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."unaccent_lexize"("internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unaccent_lexize"("internal", "internal", "internal", "internal") TO "service_role";

GRANT ALL ON FUNCTION "public"."update_cee_sectors_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_cee_sectors_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_cee_sectors_updated_at"() TO "service_role";

GRANT ALL ON FUNCTION "public"."update_streets_search_text"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_streets_search_text"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_streets_search_text"() TO "service_role";

GRANT ALL ON FUNCTION "public"."upsert_numbering_rule"("p_id" integer, "p_zip_code_id" integer, "p_start_number" integer, "p_end_number" integer, "p_side" "text", "p_description" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_numbering_rule"("p_id" integer, "p_zip_code_id" integer, "p_start_number" integer, "p_end_number" integer, "p_side" "text", "p_description" "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "service_role";

GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "service_role";

GRANT ALL ON TABLE "public"."bug_reports" TO "anon";
GRANT ALL ON TABLE "public"."bug_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."bug_reports" TO "service_role";

GRANT ALL ON SEQUENCE "public"."bug_reports_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."bug_reports_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."bug_reports_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."cee_sectors" TO "anon";
GRANT ALL ON TABLE "public"."cee_sectors" TO "authenticated";
GRANT ALL ON TABLE "public"."cee_sectors" TO "service_role";

GRANT ALL ON SEQUENCE "public"."cee_sectors_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."cee_sectors_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."cee_sectors_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."contact_messages" TO "anon";
GRANT ALL ON TABLE "public"."contact_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_messages" TO "service_role";

GRANT ALL ON SEQUENCE "public"."contact_messages_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."contact_messages_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."contact_messages_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."daily_malote_deliveries" TO "anon";
GRANT ALL ON TABLE "public"."daily_malote_deliveries" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_malote_deliveries" TO "service_role";

GRANT ALL ON SEQUENCE "public"."daily_malote_deliveries_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."daily_malote_deliveries_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."daily_malote_deliveries_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."daily_object_scans" TO "anon";
GRANT ALL ON TABLE "public"."daily_object_scans" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_object_scans" TO "service_role";

GRANT ALL ON SEQUENCE "public"."daily_object_scans_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."daily_object_scans_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."daily_object_scans_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."daily_operation_notes" TO "anon";
GRANT ALL ON TABLE "public"."daily_operation_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_operation_notes" TO "service_role";

GRANT ALL ON SEQUENCE "public"."daily_operation_notes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."daily_operation_notes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."daily_operation_notes_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."daily_truck_arrivals" TO "anon";
GRANT ALL ON TABLE "public"."daily_truck_arrivals" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_truck_arrivals" TO "service_role";

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."daily_operation_summary" TO "anon";
GRANT ALL ON TABLE "public"."daily_operation_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_operation_summary" TO "service_role";

GRANT ALL ON SEQUENCE "public"."daily_truck_arrivals_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."daily_truck_arrivals_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."daily_truck_arrivals_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."employee_attendance" TO "anon";
GRANT ALL ON TABLE "public"."employee_attendance" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_attendance" TO "service_role";

GRANT ALL ON SEQUENCE "public"."employee_attendance_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."employee_attendance_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."employee_attendance_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."employee_calendar_events" TO "anon";
GRANT ALL ON TABLE "public"."employee_calendar_events" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_calendar_events" TO "service_role";

GRANT ALL ON SEQUENCE "public"."employee_calendar_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."employee_calendar_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."employee_calendar_events_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."employee_leaves" TO "anon";
GRANT ALL ON TABLE "public"."employee_leaves" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_leaves" TO "service_role";

GRANT ALL ON TABLE "public"."employees" TO "anon";
GRANT ALL ON TABLE "public"."employees" TO "authenticated";
GRANT ALL ON TABLE "public"."employees" TO "service_role";

GRANT ALL ON TABLE "public"."employee_current_status" TO "anon";
GRANT ALL ON TABLE "public"."employee_current_status" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_current_status" TO "service_role";

GRANT ALL ON SEQUENCE "public"."employee_leaves_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."employee_leaves_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."employee_leaves_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."employee_upcoming_vacations" TO "anon";
GRANT ALL ON TABLE "public"."employee_upcoming_vacations" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_upcoming_vacations" TO "service_role";

GRANT ALL ON SEQUENCE "public"."employees_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."employees_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."employees_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."geocoding_cache" TO "anon";
GRANT ALL ON TABLE "public"."geocoding_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."geocoding_cache" TO "service_role";

GRANT ALL ON SEQUENCE "public"."geocoding_cache_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."geocoding_cache_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."geocoding_cache_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."global_api_logs" TO "anon";
GRANT ALL ON TABLE "public"."global_api_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."global_api_logs" TO "service_role";

GRANT ALL ON SEQUENCE "public"."global_api_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."global_api_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."global_api_logs_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."helpdesk_attachments" TO "anon";
GRANT ALL ON TABLE "public"."helpdesk_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."helpdesk_attachments" TO "service_role";

GRANT ALL ON SEQUENCE "public"."helpdesk_attachments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."helpdesk_attachments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."helpdesk_attachments_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."helpdesk_messages" TO "anon";
GRANT ALL ON TABLE "public"."helpdesk_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."helpdesk_messages" TO "service_role";

GRANT ALL ON SEQUENCE "public"."helpdesk_messages_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."helpdesk_messages_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."helpdesk_messages_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."helpdesk_ticket_supervisors" TO "anon";
GRANT ALL ON TABLE "public"."helpdesk_ticket_supervisors" TO "authenticated";
GRANT ALL ON TABLE "public"."helpdesk_ticket_supervisors" TO "service_role";

GRANT ALL ON TABLE "public"."helpdesk_tickets" TO "anon";
GRANT ALL ON TABLE "public"."helpdesk_tickets" TO "authenticated";
GRANT ALL ON TABLE "public"."helpdesk_tickets" TO "service_role";

GRANT ALL ON SEQUENCE "public"."helpdesk_tickets_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."helpdesk_tickets_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."helpdesk_tickets_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."numbering_rules" TO "anon";
GRANT ALL ON TABLE "public"."numbering_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."numbering_rules" TO "service_role";

GRANT ALL ON SEQUENCE "public"."numbering_rules_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."numbering_rules_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."numbering_rules_id_seq" TO "service_role";

GRANT ALL ON TABLE "public"."streets" TO "anon";
GRANT ALL ON TABLE "public"."streets" TO "authenticated";
GRANT ALL ON TABLE "public"."streets" TO "service_role";

GRANT ALL ON TABLE "public"."zip_codes" TO "anon";
GRANT ALL ON TABLE "public"."zip_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."zip_codes" TO "service_role";

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."stats_data_quality" TO "anon";
GRANT ALL ON TABLE "public"."stats_data_quality" TO "authenticated";
GRANT ALL ON TABLE "public"."stats_data_quality" TO "service_role";

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."stats_global_counts" TO "anon";
GRANT ALL ON TABLE "public"."stats_global_counts" TO "authenticated";
GRANT ALL ON TABLE "public"."stats_global_counts" TO "service_role";

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."stats_neighborhoods" TO "anon";
GRANT ALL ON TABLE "public"."stats_neighborhoods" TO "authenticated";
GRANT ALL ON TABLE "public"."stats_neighborhoods" TO "service_role";

GRANT ALL ON TABLE "public"."street_search_logs" TO "anon";
GRANT ALL ON TABLE "public"."street_search_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."street_search_logs" TO "service_role";

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."stats_search_activity_daily" TO "anon";
GRANT ALL ON TABLE "public"."stats_search_activity_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."stats_search_activity_daily" TO "service_role";

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."stats_streets_missing_zips" TO "anon";
GRANT ALL ON TABLE "public"."stats_streets_missing_zips" TO "authenticated";
GRANT ALL ON TABLE "public"."stats_streets_missing_zips" TO "service_role";

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."stats_zips_missing_rules" TO "anon";
GRANT ALL ON TABLE "public"."stats_zips_missing_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."stats_zips_missing_rules" TO "service_role";

GRANT ALL ON SEQUENCE "public"."street_search_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."street_search_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."street_search_logs_id_seq" TO "service_role";

GRANT ALL ON SEQUENCE "public"."streets_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."streets_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."streets_id_seq" TO "service_role";

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."streets_with_zip_count" TO "anon";
GRANT ALL ON TABLE "public"."streets_with_zip_count" TO "authenticated";
GRANT ALL ON TABLE "public"."streets_with_zip_count" TO "service_role";

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."top_consulted_streets" TO "anon";
GRANT ALL ON TABLE "public"."top_consulted_streets" TO "authenticated";
GRANT ALL ON TABLE "public"."top_consulted_streets" TO "service_role";

GRANT ALL ON TABLE "public"."user_profiles" TO "anon";
GRANT ALL ON TABLE "public"."user_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_profiles" TO "service_role";

GRANT ALL ON TABLE "public"."user_roles" TO "anon";
GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";

GRANT ALL ON SEQUENCE "public"."zip_codes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."zip_codes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."zip_codes_id_seq" TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

