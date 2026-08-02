// supabase/functions/geocode/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const { cep, number } = await req.json()
        const googleApiKey = Deno.env.get('GOOGLE_MAPS_API_KEY')

        if (!googleApiKey) {
            throw new Error('Google Maps API key is not configured.')
        }

        // Initialize Supabase client using environment variables
        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
        const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
        
        // Pass the user's Auth header to enforce Row Level Security (RLS)
        const authHeader = req.headers.get('Authorization')!
        const supabase = createClient(supabaseUrl, supabaseKey, {
            global: { headers: { Authorization: authHeader } }
        })

        // 1. Retrieve street info from the database
        const { data: zipData, error: zipError } = await supabase
            .from('zip_codes')
            .select('zip_code, streets(name, neighborhood)')
            .eq('zip_code', cep)
            .limit(1)
            .maybeSingle()

        if (zipError || !zipData || !zipData.streets) {
            return new Response(JSON.stringify({ error: `CEP ${cep} not found in the local database.` }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 404,
            })
        }

        const streetName = zipData.streets.name;
        const neighborhood = Array.isArray(zipData.streets.neighborhood) && zipData.streets.neighborhood.length > 0
            ? zipData.streets.neighborhood[0]
            : '';

        // Build the full address string
        const fullAddress = `${streetName}, ${number}, ${neighborhood}, Florianópolis, SC, Brasil`;
        const encodedAddress = encodeURIComponent(fullAddress);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedAddress}&key=${googleApiKey}`;

        // 2. Fetch data from Google Maps API
        const response = await fetch(url);
        const googleData = await response.json();

        if (googleData.status !== 'OK' || googleData.results.length === 0) {
            return new Response(JSON.stringify({ error: `Google Geocoding failed: ${googleData.status}` }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 400,
            })
        }

        const result = googleData.results[0];
        const location = result.geometry.location;

        const payload = {
            zip_code: cep,
            street_number: number,
            lat: location.lat,
            lon: location.lng,
            formatted_address: result.formatted_address,
            location_type: result.geometry.location_type
        };

        // 3. Save the new coordinates to the Supabase cache
        const { error: insertError } = await supabase
            .from('geocoding_cache')
            .insert(payload)

        if (insertError) {
            console.warn('Failed to save to cache:', insertError.message)
        }

        // 4. Return the successful result
        return new Response(JSON.stringify({
            lat: payload.lat,
            lon: payload.lon,
            location_type: payload.location_type,
            formatted_address: payload.formatted_address,
            source: 'google'
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        })

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        })
    }
})
