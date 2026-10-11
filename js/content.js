// Words, not logic: the preparedness checklist and the methodology notes.
// Kept apart from the code so they are easy to review and edit.

export const CHECKLIST = {
  floods: [
    {
      id: 'zone',
      title: 'Look up your hurricane evacuation zone',
      text: 'Zones 1–6 tell you when to leave before a coastal storm. Know yours before the storm, not during it.',
      link: { href: 'https://maps.nyc.gov/hurricane/', label: 'NYC Evacuation Zone Finder' },
    },
    {
      id: 'notify',
      title: 'Sign up for Notify NYC',
      text: "The city's free emergency alerts by text, email or phone, in many languages.",
      link: { href: 'https://www.nyc.gov/notifynyc', label: 'Notify NYC' },
    },
    {
      id: 'basement',
      title: 'Plan two ways out of any basement apartment',
      text: '11 of the 13 New Yorkers who died during Ida were in basement apartments. Water can fill them in minutes.',
    },
    {
      id: 'drive',
      title: 'Never walk or drive through floodwater',
      text: '6 inches of moving water can knock you down. 12 inches can float a car. Turn around, don’t drown.',
      link: { href: 'https://www.weather.gov/safety/flood-turn-around-dont-drown', label: 'NWS flood safety' },
    },
    {
      id: 'valuables',
      title: 'Keep documents and medicine up high',
      text: 'Store IDs, insurance papers and prescriptions in waterproof bags above floor level.',
    },
    {
      id: 'insurance',
      title: 'Check whether you need flood insurance',
      text: "Standard homeowner and renter policies don't cover flooding. Renters can insure their belongings, too.",
      link: { href: 'https://www.floodhelpny.org/', label: 'FloodHelpNY' },
    },
    {
      id: 'drains',
      title: 'Report clogged storm drains to 311',
      text: 'Leaves and trash on catch basins make street flooding worse. Clear the one outside your door if it is safe.',
    },
  ],
  heat: [
    {
      id: 'ac',
      title: 'Have a way to stay cool at home',
      text: 'Air conditioning is the best protection from heat illness. Ask 311 about free AC programs if you qualify.',
    },
    {
      id: 'neighbors',
      title: 'Check on older neighbors and anyone living alone',
      text: 'Most heat deaths in NYC happen at home, to people without air conditioning. A knock on the door saves lives.',
    },
    {
      id: 'cooling',
      title: 'Know where the nearest cooling center is',
      text: 'During heat emergencies the city opens libraries, community centers and senior centers. Call 311 to find one.',
    },
    {
      id: 'signs',
      title: 'Learn the signs of heat stroke',
      text: 'Hot, dry skin, confusion, a fast pulse or fainting means call 911 and start cooling the person right away.',
      link: { href: 'https://www.weather.gov/safety/heat-illness', label: 'NWS heat illness guide' },
    },
    {
      id: 'water',
      title: 'Drink water before you feel thirsty',
      text: 'Plan outdoor work and sports for early morning or evening, and take breaks in the shade.',
    },
    {
      id: 'car',
      title: 'Never leave kids or pets in a parked car',
      text: 'On an 80°F day the inside of a car can pass 100°F in 20 minutes, even with a window cracked.',
    },
  ],
  air: [
    {
      id: 'aqi',
      title: 'Check the AQI before exercising outside',
      text: 'Above 100, people with asthma, kids and older adults should take it easy. Above 150, everyone should.',
      link: { href: 'https://www.airnow.gov/', label: 'AirNow' },
    },
    {
      id: 'masks',
      title: 'Keep N95 or KN95 masks at home',
      text: 'Cloth and surgical masks do little against smoke. A well-fitting N95 blocks most fine particles.',
    },
    {
      id: 'indoors',
      title: 'Make one room a clean-air room',
      text: 'On smoke days close the windows and run an air purifier or AC on recirculate.',
    },
    {
      id: 'asthma',
      title: 'Keep an asthma action plan handy',
      text: 'If you or your child has asthma, keep inhalers stocked and know when to call the doctor.',
    },
    {
      id: 'alerts',
      title: 'Turn on air quality alerts',
      text: 'Notify NYC and most weather apps can warn you when the AQI climbs.',
      link: { href: 'https://www.nyc.gov/notifynyc', label: 'Notify NYC' },
    },
  ],
  wind: [
    {
      id: 'secure',
      title: 'Bring in or tie down loose objects',
      text: 'Balcony furniture, planters and trash cans become dangerous in 50+ mph gusts.',
    },
    {
      id: 'power',
      title: 'Charge phones and power banks before the storm',
      text: 'Keep flashlights and batteries ready. Use flashlights, not candles, if the power goes out.',
    },
    {
      id: 'lines',
      title: 'Stay far from downed power lines',
      text: 'Assume every downed wire is live. Report it to 911 and to Con Edison.',
      link: { href: 'https://www.coned.com/', label: 'Con Edison' },
    },
    {
      id: 'trees',
      title: 'Report fallen trees and limbs to 311',
      text: 'Stay out of parks during high winds. Branches can fall hours after a storm passes.',
    },
    {
      id: 'watch',
      title: 'Know a Watch from a Warning',
      text: 'A watch means conditions are possible, so get ready. A warning means it is happening or about to, so act now.',
    },
    {
      id: 'gobag',
      title: 'Pack a Go Bag',
      text: 'Water, medicine, copies of IDs, a charger, cash and a flashlight, ready to grab in minutes.',
      link: { href: 'https://www.ready.gov/kit', label: 'Ready.gov kit list' },
    },
  ],
};

export const METHODOLOGY = {
  floods: {
    title: 'Floods: tides, storm surge and rainfall',
    html: `
      <p>Each neighborhood gets a <strong>coastal</strong> and a <strong>stormwater</strong> score, and the higher one wins.</p>
      <ul>
        <li><strong>Coastal hazard (0–4):</strong> the highest water level in the next 48 h (NOAA predicted tide plus the current storm surge), compared with NOAA's minor, moderate and major flood thresholds for that tide gauge.</li>
        <li><strong>Stormwater hazard (0–4):</strong> the heaviest forecast hour of rain against NYC's ~1.75 in/hr sewer design capacity. Soaked ground (1.5+ in in the past 24 h) adds a step.</li>
        <li><strong>Exposure (0–3)</strong> scales each hazard. It is simplified from FEMA flood maps, NYC DEP stormwater flood maps and damage from Sandy and Ida. Address checks use the real FEMA zone and a year of 311 flooding reports instead.</li>
        <li>NWS flood alerts and recent 311 street-flooding reports within 1 km add to the score.</li>
      </ul>`,
  },
  heat: {
    title: 'Heat: heat index and vulnerability',
    html: `
      <ul>
        <li><strong>Hazard (0–4)</strong> from the peak NWS heat index (temperature plus humidity) in the next 48 h: 80, 90, 100 and 105°F are the steps. NWS New York issues a Heat Advisory around 95–100°F and an Extreme Heat Warning at 105°F.</li>
        <li><strong>Warm nights</strong> (lows of 75°F or more) add risk because bodies can't recover overnight.</li>
        <li><strong>Vulnerability:</strong> the score is multiplied by a factor from NYC's Heat Vulnerability Index (1–5). The index reflects surface temperature, green space, access to home air conditioning, income, and the lasting effects of structural racism.</li>
      </ul>
      <p>The same 98°F afternoon is rated Elevated in a leafy, air-conditioned neighborhood and High where the index is 5.</p>`,
  },
  air: {
    title: 'Air quality: AQI and asthma burden',
    html: `
      <ul>
        <li><strong>Hazard (0–4)</strong> follows the EPA's US Air Quality Index for the next 48 h: Good (0–50), Moderate, Unhealthy for sensitive groups, Unhealthy, and Very unhealthy or worse (200+).</li>
        <li>The forecast comes from the Open-Meteo air quality model, which covers fine particles (PM2.5, the main pollutant in wildfire smoke) and ozone (smog).</li>
        <li>Neighborhoods with a heavy <strong>asthma burden</strong> move up half a step once the air is no longer Good, because the same air sends more people to the ER there.</li>
        <li>An NWS Air Quality Alert adds half a step.</li>
      </ul>`,
  },
  wind: {
    title: 'Wind & storms: gusts, thunderstorms and exposure',
    html: `
      <ul>
        <li><strong>Hazard (0–4)</strong> from the strongest forecast gust: 30, 46 (NWS Wind Advisory), 58 (High Wind Warning) and 74 mph (hurricane force). Sustained winds of 31, 40 and 74 mph count too.</li>
        <li>Thunderstorms in the forecast add lightning and sudden-gust risk, and hail makes it worse.</li>
        <li><strong>Exposure:</strong> open ocean and Long Island Sound shorelines get the full force of the wind (×1.2). Waterfronts and tree-lined streets, where falling limbs take down power lines, get ×1.0. Sheltered inland blocks get ×0.8.</li>
        <li>NWS wind, tropical storm and tornado alerts add to the score.</li>
      </ul>`,
  },
};
