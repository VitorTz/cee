// =============================================================================
// MODULE: CACHED GEOCODING (SUPABASE + GOOGLE MAPS)
// =============================================================================
import { sb } from "../supabase-client.js";
import { GEOCODING_KEY } from "../../config.js";

/**
 * Fetches latitude and longitude for an address. 
 * Checks the Supabase cache first, and falls back to Google Maps API if not found.
 * Example usage:
 * getCachedGeocoding('88010-000', '123').then(console.log);
 * 
 * @param {string} cep - The Brazilian ZIP code
 * @param {string|number} number - The street number
 * @returns {Promise<{lat: number, lon: number, location_type: string, source: string}|null>}
 */
async function getCachedGeocoding(cep, number) {
    // 1. Normalize inputs
    // Format CEP to standard "880XX-XXX" to ensure consistent cache keys
    const normalizedCep = normalizeCep(cep);
    const normalizedNumber = String(number).trim().toUpperCase();

    try {
        // 2. Check if the coordinates already exist in the Supabase cache
        const { data: cachedData, error: cacheError } = await sb
            .from('geocoding_cache')
            .select('*')
            .eq('zip_code', normalizedCep)
            .eq('street_number', normalizedNumber)
            .maybeSingle();

        if (cachedData) {
            console.log('Coordinates loaded from Supabase Cache.');
            return {
                lat: Number(cachedData.lat),
                lon: Number(cachedData.lon),
                location_type: cachedData.location_type,
                formatted_address: cachedData.formatted_address,
                source: 'cache'
            };
        }

        // 3. Cache Miss: Retrieve street info from the database to build the address
        const { data: zipData, error: zipError } = await sb
            .from('zip_codes')
            .select('zip_code, streets(name, neighborhood)')
            .eq('zip_code', normalizedCep)
            .limit(1)
            .maybeSingle();

        if (!zipData || !zipData.streets) {
            throw new Error(`CEP ${normalizedCep} not found in the local database.`);
        }

        const streetName = zipData.streets.name;
        // Safely extract the first neighborhood from the array
        const neighborhood = Array.isArray(zipData.streets.neighborhood) && zipData.streets.neighborhood.length > 0
            ? zipData.streets.neighborhood[0]
            : '';

        // Build the full address. 
        // Note: Assuming all operation takes place in Florianópolis, SC.
        const fullAddress = `${streetName}, ${normalizedNumber}, ${neighborhood}, Florianópolis, SC, Brasil`;
        const encodedAddress = encodeURIComponent(fullAddress);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedAddress}&key=${GEOCODING_KEY}`;

        // 4. Request from Google Maps API
        console.log('Cache miss. Fetching from Google Maps API...');
        const response = await fetch(url);
        const googleData = await response.json();

        if (googleData.status === 'OK' && googleData.results.length > 0) {
            const result = googleData.results[0];
            const location = result.geometry.location;

            const payload = {
                zip_code: normalizedCep,
                street_number: normalizedNumber,
                lat: location.lat,
                lon: location.lng,
                formatted_address: result.formatted_address,
                location_type: result.geometry.location_type
            };

            // 5. Save the new coordinates to the Supabase cache for future use
            const { error: insertError } = await sb
                .from('geocoding_cache')
                .insert(payload);

            if (insertError) {
                console.warn('Failed to save to geocoding cache:', insertError.message);
            }

            return {
                lat: payload.lat,
                lon: payload.lon,
                location_type: payload.location_type,
                formatted_address: payload.formatted_address,
                source: 'google'
            };
        } else {
            console.error('Google Geocoding failed with status:', googleData.status);
            return null;
        }

    } catch (error) {
        console.error('Error during geocoding process:', error);
        return null;
    }
}
