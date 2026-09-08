/* The built-in pictures: famous paintings, all long out of copyright.
 *
 * Referenced by URL rather than bundled - the host sends the URL and every
 * player loads it straight from Wikimedia, so a fifteen-painting gallery costs
 * this app no bandwidth and no repo weight.
 *
 * WHICH PAINTINGS, AND WHY THESE ONES
 *
 * A jigsaw piece is only placeable if it carries detail. A painting with large
 * flat regions - fog, open sky, smooth water - produces pieces that look
 * identical to a dozen others, and those are the pieces that make a puzzle
 * miserable rather than pleasant.
 *
 * So this list is measured, not chosen by taste. Each candidate was cut into the
 * same grid the game uses and the local contrast of every cell was measured; the
 * "detail" number below is the 10th-percentile cell, i.e. how much texture the
 * BLANDEST pieces carry. Anything that failed was dropped, including some famous
 * ones: Impression Sunrise was 63% featureless, The Night Watch 36%, The Great
 * Wave and American Gothic 21% each.
 *
 * Ordered easiest first. Re-measure with tools/score-art.js if you add any.
 *
 * `dataUrl` is the wire field name; the server takes either inline image bytes
 * or a plain http(s) URL, and this is the URL case. */

const Gallery = (() => {
  const ART = [
  {
    title: "Primavera",
    artist: "Sandro Botticelli, c.1480",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/25/Sandro_Botticelli_-_La_Primavera_-_Google_Art_Project.jpg/1920px-Sandro_Botticelli_-_La_Primavera_-_Google_Art_Project.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/25/Sandro_Botticelli_-_La_Primavera_-_Google_Art_Project.jpg/500px-Sandro_Botticelli_-_La_Primavera_-_Google_Art_Project.jpg",
    w: 1400, h: 930,
    detail: 48.4, difficulty: "easy"
  },
  {
    title: "Cafe Terrace at Night",
    artist: "Vincent van Gogh, 1888",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/04/Vincent-van-gogh-cafe-terrace-on-the-place-du-forum-arles-at-night-the.jpg/1920px-Vincent-van-gogh-cafe-terrace-on-the-place-du-forum-arles-at-night-the.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/04/Vincent-van-gogh-cafe-terrace-on-the-place-du-forum-arles-at-night-the.jpg/500px-Vincent-van-gogh-cafe-terrace-on-the-place-du-forum-arles-at-night-the.jpg",
    w: 1400, h: 1792,
    detail: 43.4, difficulty: "easy"
  },
  {
    title: "The Garden of Earthly Delights",
    artist: "Hieronymus Bosch, c.1500",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6d/The_Garden_of_Earthly_Delights_by_Bosch_High_Resolution.jpg/1920px-The_Garden_of_Earthly_Delights_by_Bosch_High_Resolution.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6d/The_Garden_of_Earthly_Delights_by_Bosch_High_Resolution.jpg/500px-The_Garden_of_Earthly_Delights_by_Bosch_High_Resolution.jpg",
    w: 1400, h: 797,
    detail: 36.8, difficulty: "easy"
  },
  {
    title: "Bal du moulin de la Galette",
    artist: "Pierre-Auguste Renoir, 1876",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6f/Renoir%2C_Pierre-Auguste_-_Dance_at_Le_Moulin_de_la_Galette%2C_1876.jpg/1920px-Renoir%2C_Pierre-Auguste_-_Dance_at_Le_Moulin_de_la_Galette%2C_1876.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6f/Renoir%2C_Pierre-Auguste_-_Dance_at_Le_Moulin_de_la_Galette%2C_1876.jpg/500px-Renoir%2C_Pierre-Auguste_-_Dance_at_Le_Moulin_de_la_Galette%2C_1876.jpg",
    w: 1400, h: 1041,
    detail: 32.4, difficulty: "easy"
  },
  {
    title: "Netherlandish Proverbs",
    artist: "Pieter Bruegel the Elder, 1559",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7e/Pieter_Brueghel_the_Elder_-_The_Dutch_Proverbs_-_Google_Art_Project.jpg/1920px-Pieter_Brueghel_the_Elder_-_The_Dutch_Proverbs_-_Google_Art_Project.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7e/Pieter_Brueghel_the_Elder_-_The_Dutch_Proverbs_-_Google_Art_Project.jpg/500px-Pieter_Brueghel_the_Elder_-_The_Dutch_Proverbs_-_Google_Art_Project.jpg",
    w: 1400, h: 991,
    detail: 31.7, difficulty: "easy"
  },
  {
    title: "Irises",
    artist: "Vincent van Gogh, 1889",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c8/Vincent_van_Gogh_-_Irises_%281889%29.jpg/1920px-Vincent_van_Gogh_-_Irises_%281889%29.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c8/Vincent_van_Gogh_-_Irises_%281889%29.jpg/500px-Vincent_van_Gogh_-_Irises_%281889%29.jpg",
    w: 1400, h: 1081,
    detail: 30.6, difficulty: "easy"
  },
  {
    title: "Hunters in the Snow",
    artist: "Pieter Bruegel the Elder, 1565",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d8/Pieter_Bruegel_the_Elder_-_Hunters_in_the_Snow_%28Winter%29_-_Google_Art_Project.jpg/1920px-Pieter_Bruegel_the_Elder_-_Hunters_in_the_Snow_%28Winter%29_-_Google_Art_Project.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d8/Pieter_Bruegel_the_Elder_-_Hunters_in_the_Snow_%28Winter%29_-_Google_Art_Project.jpg/500px-Pieter_Bruegel_the_Elder_-_Hunters_in_the_Snow_%28Winter%29_-_Google_Art_Project.jpg",
    w: 1400, h: 996,
    detail: 30.1, difficulty: "easy"
  },
  {
    title: "The Starry Night",
    artist: "Vincent van Gogh, 1889",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg/1920px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg/500px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg",
    w: 1400, h: 1109,
    detail: 29.7, difficulty: "medium"
  },
  {
    title: "A Sunday on La Grande Jatte",
    artist: "Georges Seurat, 1884",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7d/A_Sunday_on_La_Grande_Jatte%2C_Georges_Seurat%2C_1884.jpg/1920px-A_Sunday_on_La_Grande_Jatte%2C_Georges_Seurat%2C_1884.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7d/A_Sunday_on_La_Grande_Jatte%2C_Georges_Seurat%2C_1884.jpg/500px-A_Sunday_on_La_Grande_Jatte%2C_Georges_Seurat%2C_1884.jpg",
    w: 1400, h: 932,
    detail: 27.9, difficulty: "medium"
  },
  {
    title: "The Haywain",
    artist: "Hieronymus Bosch, c.1516",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4c/Jheronimus_Bosch_-_De_hooiwagen_%28c.1516%2C_Prado%29.jpg/1920px-Jheronimus_Bosch_-_De_hooiwagen_%28c.1516%2C_Prado%29.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4c/Jheronimus_Bosch_-_De_hooiwagen_%28c.1516%2C_Prado%29.jpg/500px-Jheronimus_Bosch_-_De_hooiwagen_%28c.1516%2C_Prado%29.jpg",
    w: 1400, h: 991,
    detail: 27.2, difficulty: "medium"
  },
  {
    title: "Wheatfield with Cypresses",
    artist: "Vincent van Gogh, 1889",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/ce/Wheat-Field-with-Cypresses-%281889%29-Vincent-van-Gogh-Met.jpg/1920px-Wheat-Field-with-Cypresses-%281889%29-Vincent-van-Gogh-Met.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/c/ce/Wheat-Field-with-Cypresses-%281889%29-Vincent-van-Gogh-Met.jpg/500px-Wheat-Field-with-Cypresses-%281889%29-Vincent-van-Gogh-Met.jpg",
    w: 1400, h: 1097,
    detail: 25.6, difficulty: "medium"
  },
  {
    title: "The Birth of Venus",
    artist: "Sandro Botticelli, c.1485",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0b/Sandro_Botticelli_-_La_nascita_di_Venere_-_Google_Art_Project_-_edited.jpg/1920px-Sandro_Botticelli_-_La_nascita_di_Venere_-_Google_Art_Project_-_edited.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0b/Sandro_Botticelli_-_La_nascita_di_Venere_-_Google_Art_Project_-_edited.jpg/500px-Sandro_Botticelli_-_La_nascita_di_Venere_-_Google_Art_Project_-_edited.jpg",
    w: 1400, h: 879,
    detail: 24.9, difficulty: "medium"
  },
  {
    title: "Children's Games",
    artist: "Pieter Bruegel the Elder, 1560",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1e/Pieter_Bruegel_the_Elder_-_Children%E2%80%99s_Games_-_Google_Art_Project.jpg/1920px-Pieter_Bruegel_the_Elder_-_Children%E2%80%99s_Games_-_Google_Art_Project.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1e/Pieter_Bruegel_the_Elder_-_Children%E2%80%99s_Games_-_Google_Art_Project.jpg/500px-Pieter_Bruegel_the_Elder_-_Children%E2%80%99s_Games_-_Google_Art_Project.jpg",
    w: 1400, h: 1017,
    detail: 24.5, difficulty: "medium"
  },
  {
    title: "The Kiss",
    artist: "Gustav Klimt, 1908",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/40/The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg/1920px-The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/4/40/The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg/500px-The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg",
    w: 1400, h: 1405,
    detail: 23.1, difficulty: "medium"
  },
  {
    title: "Luncheon of the Boating Party",
    artist: "Pierre-Auguste Renoir, 1881",
    dataUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8d/Pierre-Auguste_Renoir_-_Luncheon_of_the_Boating_Party_-_Google_Art_Project.jpg/1920px-Pierre-Auguste_Renoir_-_Luncheon_of_the_Boating_Party_-_Google_Art_Project.jpg",
    thumb: "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8d/Pierre-Auguste_Renoir_-_Luncheon_of_the_Boating_Party_-_Google_Art_Project.jpg/500px-Pierre-Auguste_Renoir_-_Luncheon_of_the_Boating_Party_-_Google_Art_Project.jpg",
    w: 1400, h: 1037,
    detail: 21, difficulty: "medium"
  }
  ];

  return {
    count: ART.length,
    get: (i) => ART[i],
    all: () => ART.slice()
  };
})();
