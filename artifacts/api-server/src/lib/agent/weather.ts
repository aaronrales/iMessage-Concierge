import { logger } from "../logger";

/**
 * Free, keyless weather lookup (Open-Meteo) for the serendipity feature.
 * Geocodes a city name, then pulls a daily forecast. Returns `null` on any
 * failure so a weather-lookup miss just skips serendipity for the day
 * instead of breaking the scan.
 */

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// This product currently only operates in NYC (see bookingLinks.ts), so the
// same default city applies when a thread has no known home city.
export const DEFAULT_CITY = "New York";

interface GeocodeResult {
  latitude: number;
  longitude: number;
}

async function geocodeCity(city: string): Promise<GeocodeResult | null> {
  try {
    const url = new URL(GEOCODE_URL);
    url.searchParams.set("name", city);
    url.searchParams.set("count", "1");
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = (await response.json()) as { results?: { latitude: number; longitude: number }[] };
    const first = data.results?.[0];
    return first ? { latitude: first.latitude, longitude: first.longitude } : null;
  } catch (error) {
    logger.error({ error, city }, "Open-Meteo geocoding request failed");
    return null;
  }
}

export interface DayForecast {
  date: string; // YYYY-MM-DD
  highF: number;
  precipitationChance: number; // 0-100
  isGoodWeather: boolean;
}

/** True for a comfortable, mostly-dry day -- the bar for "good weather to suggest getting together". */
function isGoodWeatherDay(highF: number, precipitationChance: number): boolean {
  return highF >= 60 && highF <= 85 && precipitationChance <= 30;
}

/**
 * Forecast for the given number of days out (0 = today), for the upcoming
 * Saturday-style "let's get together" suggestion window.
 */
export async function getForecastForDay(city: string, daysOut: number): Promise<DayForecast | null> {
  const location = await geocodeCity(city);
  if (!location) {
    logger.warn({ city }, "Could not geocode city for weather lookup");
    return null;
  }

  try {
    const url = new URL(FORECAST_URL);
    url.searchParams.set("latitude", String(location.latitude));
    url.searchParams.set("longitude", String(location.longitude));
    url.searchParams.set("daily", "temperature_2m_max,precipitation_probability_max");
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("forecast_days", String(Math.max(1, daysOut + 1)));
    url.searchParams.set("timezone", "auto");

    const response = await fetch(url);
    if (!response.ok) return null;
    const data = (await response.json()) as {
      daily?: { time: string[]; temperature_2m_max: number[]; precipitation_probability_max: number[] };
    };
    const daily = data.daily;
    if (!daily?.time?.[daysOut]) return null;

    const highF = daily.temperature_2m_max[daysOut] as number;
    const precipitationChance = daily.precipitation_probability_max[daysOut] as number;

    return {
      date: daily.time[daysOut] as string,
      highF,
      precipitationChance,
      isGoodWeather: isGoodWeatherDay(highF, precipitationChance),
    };
  } catch (error) {
    logger.error({ error, city }, "Open-Meteo forecast request failed");
    return null;
  }
}

/** Days until the next Saturday (0 if today is Saturday). */
export function daysUntilNextSaturday(from: Date = new Date()): number {
  const SATURDAY = 6;
  const diff = (SATURDAY - from.getDay() + 7) % 7;
  return diff;
}
