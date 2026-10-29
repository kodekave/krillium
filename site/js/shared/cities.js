// City and country lookups shared by the importer, the Worker and the page. A built-in table keeps lookups
// free of outside calls; a city that is not listed simply has no map position until someone approves it.
import { fold } from './clean.js';

export const CITY_COORDS = Object.freeze({
  // Europe
  london: [51.5074, -0.1278], paris: [48.8566, 2.3522], berlin: [52.52, 13.405], munich: [48.1351, 11.582],
  frankfurt: [50.1109, 8.6821], hamburg: [53.5511, 9.9937], cologne: [50.9375, 6.9603], dusseldorf: [51.2277, 6.7735],
  stuttgart: [48.7758, 9.1829], nuremberg: [49.4521, 11.0767], hannover: [52.3759, 9.732], leipzig: [51.3397, 12.3731],
  dresden: [51.0504, 13.7373], bremen: [53.0793, 8.8017], vienna: [48.2082, 16.3738], zurich: [47.3769, 8.5417],
  geneva: [46.2044, 6.1432], basel: [47.5596, 7.5886], amsterdam: [52.3676, 4.9041], rotterdam: [51.9244, 4.4777],
  'the hague': [52.0705, 4.3007], utrecht: [52.0907, 5.1214], brussels: [50.8503, 4.3517], antwerp: [51.2194, 4.4025],
  luxembourg: [49.6116, 6.1319], copenhagen: [55.6761, 12.5683], stockholm: [59.3293, 18.0686],
  gothenburg: [57.7089, 11.9746], oslo: [59.9139, 10.7522], helsinki: [60.1699, 24.9384], dublin: [53.3498, -6.2603],
  madrid: [40.4168, -3.7038], barcelona: [41.3874, 2.1686], valencia: [39.4699, -0.3763], lisbon: [38.7223, -9.1393],
  porto: [41.1579, -8.6291], estoril: [38.7057, -9.3978], milan: [45.4642, 9.19], rome: [41.9028, 12.4964],
  turin: [45.0703, 7.6869], bologna: [44.4949, 11.3426], athens: [37.9838, 23.7275], warsaw: [52.2297, 21.0122],
  krakow: [50.0647, 19.945], prague: [50.0755, 14.4378], budapest: [47.4979, 19.0402], bucharest: [44.4268, 26.1025],
  sofia: [42.6977, 23.3219], belgrade: [44.7866, 20.4489], zagreb: [45.815, 15.9819], ljubljana: [46.0569, 14.5058],
  bratislava: [48.1486, 17.1077], istanbul: [41.0082, 28.9784], edinburgh: [55.9533, -3.1883],
  manchester: [53.4808, -2.2426], birmingham: [52.4862, -1.8904], glasgow: [55.8642, -4.2518], monaco: [43.7384, 7.4246],
  nice: [43.7102, 7.262], cannes: [43.5528, 7.0174], lyon: [45.764, 4.8357], marseille: [43.2965, 5.3698],
  tallinn: [59.437, 24.7536], riga: [56.9496, 24.1052], vilnius: [54.6872, 25.2797], reykjavik: [64.1466, -21.9426],
  valletta: [35.8989, 14.5146], kyiv: [50.4501, 30.5234],
  // North America
  'new york': [40.7128, -74.006], washington: [38.9072, -77.0369], boston: [42.3601, -71.0589],
  chicago: [41.8781, -87.6298], atlanta: [33.749, -84.388], miami: [25.7617, -80.1918], orlando: [28.5383, -81.3792],
  tampa: [27.9506, -82.4572], dallas: [32.7767, -96.797], houston: [29.7604, -95.3698], austin: [30.2672, -97.7431],
  'san antonio': [29.4241, -98.4936], denver: [39.7392, -104.9903], 'las vegas': [36.1699, -115.1398],
  'los angeles': [34.0522, -118.2437], 'san diego': [32.7157, -117.1611], 'san francisco': [37.7749, -122.4194],
  'san jose': [37.3382, -121.8863], seattle: [47.6062, -122.3321], portland: [45.5152, -122.6784],
  phoenix: [33.4484, -112.074], 'salt lake city': [40.7608, -111.891], minneapolis: [44.9778, -93.265],
  detroit: [42.3314, -83.0458], philadelphia: [39.9526, -75.1652], pittsburgh: [40.4406, -79.9959],
  charlotte: [35.2271, -80.8431], nashville: [36.1627, -86.7816], 'new orleans': [29.9511, -90.0715],
  'kansas city': [39.0997, -94.5786], 'st louis': [38.627, -90.1994], indianapolis: [39.7684, -86.1581],
  columbus: [39.9612, -82.9988], cleveland: [41.4993, -81.6944], baltimore: [39.2904, -76.6122],
  schaumburg: [42.0334, -88.0834], toronto: [43.6532, -79.3832], montreal: [45.5017, -73.5673],
  vancouver: [49.2827, -123.1207], calgary: [51.0447, -114.0719], ottawa: [45.4215, -75.6972],
  'mexico city': [19.4326, -99.1332],
  // Asia-Pacific
  singapore: [1.3521, 103.8198], 'hong kong': [22.3193, 114.1694], tokyo: [35.6762, 139.6503], osaka: [34.6937, 135.5023],
  seoul: [37.5665, 126.978], beijing: [39.9042, 116.4074], shanghai: [31.2304, 121.4737], shenzhen: [22.5431, 114.0579],
  taipei: [25.033, 121.5654], bangkok: [13.7563, 100.5018], 'kuala lumpur': [3.139, 101.6869], jakarta: [-6.2088, 106.8456],
  manila: [14.5995, 120.9842], 'ho chi minh city': [10.8231, 106.6297], hanoi: [21.0285, 105.8542],
  mumbai: [19.076, 72.8777], delhi: [28.6139, 77.209], bengaluru: [12.9716, 77.5946], hyderabad: [17.385, 78.4867],
  chennai: [13.0827, 80.2707], pune: [18.5204, 73.8567], kolkata: [22.5726, 88.3639], kathmandu: [27.7172, 85.324],
  colombo: [6.9271, 79.8612], dhaka: [23.8103, 90.4125], sydney: [-33.8688, 151.2093], melbourne: [-37.8136, 144.9631],
  brisbane: [-27.4698, 153.0251], perth: [-31.9505, 115.8605], auckland: [-36.8485, 174.7633],
  wellington: [-41.2866, 174.7756],
  // Middle East and Africa
  dubai: [25.2048, 55.2708], 'abu dhabi': [24.4539, 54.3773], riyadh: [24.7136, 46.6753], doha: [25.2854, 51.531],
  manama: [26.2285, 50.586], muscat: [23.588, 58.3829], 'kuwait city': [29.3759, 47.9774], 'tel aviv': [32.0853, 34.7818],
  amman: [31.9454, 35.9284], cairo: [30.0444, 31.2357], casablanca: [33.5731, -7.5898], marrakech: [31.6295, -7.9811],
  lagos: [6.5244, 3.3792], nairobi: [-1.2921, 36.8219], johannesburg: [-26.2041, 28.0473], 'cape town': [-33.9249, 18.4241],
  accra: [5.6037, -0.187], 'addis ababa': [9.03, 38.7408],
  // Latin America
  'sao paulo': [-23.5505, -46.6333], 'rio de janeiro': [-22.9068, -43.1729], 'buenos aires': [-34.6037, -58.3816],
  bogota: [4.711, -74.0721], lima: [-12.0464, -77.0428], santiago: [-33.4489, -70.6693], 'panama city': [8.9824, -79.5199],
});

const CITY_ALIASES = {
  munchen: 'munich', koln: 'cologne', wien: 'vienna', praha: 'prague', roma: 'rome', milano: 'milan', lisboa: 'lisbon',
  geneve: 'geneva', bruxelles: 'brussels', brussel: 'brussels', kobenhavn: 'copenhagen', warszawa: 'warsaw',
  'den haag': 'the hague', kiev: 'kyiv', nyc: 'new york', bangalore: 'bengaluru', 'new delhi': 'delhi', bombay: 'mumbai',
  peking: 'beijing', 'ho chi minh': 'ho chi minh city', saigon: 'ho chi minh city', 'st. louis': 'st louis',
};

export function coordsForCity(city) {
  const folded = fold(city).replace(/,.*$/, '').replace(/\s+dc$/, '').trim();
  const key = Object.hasOwn(CITY_ALIASES, folded) ? CITY_ALIASES[folded] : folded;
  return Object.hasOwn(CITY_COORDS, key) ? [...CITY_COORDS[key]] : [null, null];
}

const COUNTRY_NAMES = {
  AE: ['united arab emirates', 'uae'], AR: ['argentina'], AT: ['austria'], AU: ['australia'], BD: ['bangladesh'],
  BE: ['belgium'], BG: ['bulgaria'], BH: ['bahrain'], BR: ['brazil'], CA: ['canada'], CH: ['switzerland'],
  CL: ['chile'], CN: ['china'], CO: ['colombia'], CY: ['cyprus'], CZ: ['czechia', 'czech republic'], DE: ['germany', 'deutschland'],
  DK: ['denmark'], DZ: ['algeria'], EE: ['estonia'], EG: ['egypt'], ES: ['spain'], ET: ['ethiopia'], FI: ['finland'],
  FR: ['france'], GB: ['united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales', 'northern ireland'],
  GH: ['ghana'], GR: ['greece'], HK: ['hong kong'], HR: ['croatia'], HU: ['hungary'], ID: ['indonesia'], IE: ['ireland'],
  IL: ['israel'], IN: ['india'], IS: ['iceland'], IT: ['italy'], JO: ['jordan'], JP: ['japan'], KE: ['kenya'],
  KR: ['south korea', 'korea', 'republic of korea'], KW: ['kuwait'], LK: ['sri lanka'], LT: ['lithuania'],
  LU: ['luxembourg'], LV: ['latvia'], MA: ['morocco'], MC: ['monaco'], MT: ['malta'], MX: ['mexico'], MY: ['malaysia'],
  NG: ['nigeria'], NL: ['netherlands', 'the netherlands', 'holland'], NO: ['norway'], NP: ['nepal'],
  NZ: ['new zealand'], OM: ['oman'], PA: ['panama'], PE: ['peru'], PH: ['philippines'], PK: ['pakistan'], PL: ['poland'],
  PT: ['portugal'], QA: ['qatar'], RO: ['romania'], RS: ['serbia'], SA: ['saudi arabia'], SE: ['sweden'],
  SG: ['singapore'], SI: ['slovenia'], SK: ['slovakia'], TH: ['thailand'], TR: ['turkey', 'turkiye'], TW: ['taiwan'],
  UA: ['ukraine'], US: ['united states', 'united states of america', 'usa', 'america'], VN: ['vietnam', 'viet nam'],
  ZA: ['south africa'],
};

const CODE_BY_NAME = new Map(
  Object.entries(COUNTRY_NAMES).flatMap(([code, names]) => names.map((name) => [name, code])),
);

export function countryCode(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && Object.hasOwn(COUNTRY_NAMES, upper)) return upper;
  return CODE_BY_NAME.get(fold(text)) ?? null;
}
