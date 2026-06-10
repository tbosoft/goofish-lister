const crypto = require('crypto');
const sharp = require('sharp');

function seededNumber(seed, salt = '') {
  const hex = crypto.createHash('sha1').update(`${seed}:${salt}`).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}

function randomBorderColor(seed) {
  const hue = seededNumber(seed, 'hue') % 360;
  const saturation = 55 + (seededNumber(seed, 'sat') % 21);
  const lightness = 52 + (seededNumber(seed, 'light') % 15);
  return sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: `hsl(${hue} ${saturation}% ${lightness}%)`,
    },
  })
    .png()
    .toBuffer()
    .then((buf) => sharp(buf).raw().toBuffer({ resolveWithObject: true }))
    .then(({ data }) => ({ r: data[0], g: data[1], b: data[2] }));
}

async function cropWhitespaceAndAddBorder(buf, { border, jpgQuality, seed }) {
  const borderColor = await randomBorderColor(seed);
  const pipeline = sharp(buf, { failOn: 'none' }).rotate();
  const trimmed = pipeline.trim({ background: '#ffffff', threshold: 12 });
  const jpgBuf = await trimmed
    .extend({
      top: border,
      bottom: border,
      left: border,
      right: border,
      background: borderColor,
    })
    .jpeg({ quality: jpgQuality })
    .toBuffer();

  return {
    jpgBuf,
    borderColor: `rgb(${borderColor.r}, ${borderColor.g}, ${borderColor.b})`,
  };
}

module.exports = {
  cropWhitespaceAndAddBorder,
  randomBorderColor,
  seededNumber,
};
