/**
 * Libraries from other publishers that Crossprobe offers next to KiCad's own
 * (third_party/kicad-libraries): who made each, where it comes from, and the
 * licence it is under. A design that uses a part from one says so, in the
 * schematic and in the build report.
 */
export interface ThirdPartyLibrary {
  /** KiCad nickname: the part before the colon in "Library:Name", for symbols and footprints alike. */
  nickname: string;
  title: string;
  publisher: string;
  source: string;
  /** The revision of the source the files were taken from. */
  revision: string;
  license: string;
  licenseUrl: string;
  /** What the library holds, for search results (its own symbols may carry no description). */
  description: string;
  /** How to choose among its parts: shown to an assistant that looks one of them up. */
  usage: string;
}

export const THIRD_PARTY_LIBRARIES: ThirdPartyLibrary[] = [
  {
    nickname: "Seeed_Studio_XIAO_Series",
    title: "Seeed Studio XIAO Series",
    publisher: "Seeed Studio",
    source: "https://github.com/Seeed-Studio/OPL_Kicad_Library",
    revision: "b0035c51eb0348bb3e165fdb2f2765fa3d1d17bd",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    description: "Seeed Studio XIAO board, as a part to put on a carrier board",
    usage:
      "For a XIAO on pin headers or soldered through its 14 edge holes, use the symbol XIAO-Add-On (14 pins: D0 to D10, 3V3_OUT, GND, VBUS) with the board's -DIP footprint, e.g. XIAO-nRF52840-DIP. " +
      "The -SMD symbols also have the pads under the board (SWD, battery, NFC, extra pins) and go with the -SMD footprint of the same name, for a XIAO soldered flat onto the carrier. " +
      "Every pin is passive, so ERC cannot tell which pins supply power: list the rails the XIAO feeds or is fed from (3V3, 5V/VBUS) in powerFlags. " +
      "Pin 1 is D0, beside the USB connector. On the boards with an antenna of their own (the nRF52840 among them) it is at the end away from the USB connector: keep copper and parts clear under that end.",
  },
];

/** The third-party library a "Library:Name" id belongs to, if any. */
export function thirdPartyLibrary(libId: string | undefined): ThirdPartyLibrary | undefined {
  const i = libId?.indexOf(":") ?? -1;
  return i > 0 ? THIRD_PARTY_LIBRARIES.find((l) => l.nickname === libId!.slice(0, i)) : undefined;
}

/** One line of credit: what the schematic and the report say about a library in use. */
export const libraryCredit = (l: ThirdPartyLibrary): string => `${l.title} symbols and footprints by ${l.publisher}, ${l.license} (${l.source})`;

/**
 * Index entries of a third-party library as the part pickers and the search tools show them: a
 * symbol without a description of its own gets the library's, and every one says whose it is.
 */
export function creditedIndex<T extends { library: string; name: string; description: string }>(entries: T[]): T[] {
  return entries.map((e) => {
    const from = THIRD_PARTY_LIBRARIES.find((l) => l.nickname === e.library);
    return from ? { ...e, description: `${e.description || from.description} (${from.publisher}, ${from.license})` } : e;
  });
}
