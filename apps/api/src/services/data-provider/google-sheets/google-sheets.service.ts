import { DATE_FORMAT, parseDate } from '@ghostfolio/common/helper';
import { DataProviderInfo } from '@ghostfolio/common/interfaces';

import { Injectable, Logger } from '@nestjs/common';
import { DataSource, SymbolProfile } from '@prisma/client';
import { format } from 'date-fns';
import { GoogleSpreadsheet } from 'google-spreadsheet';

import { LookupItem } from '../../../app/symbol/interfaces/lookup-item.interface';
import { ConfigurationService } from '../../configuration/configuration.service';
import {
  IDataProviderHistoricalResponse,
  IDataProviderResponse
} from '../../interfaces/interfaces';
import { PrismaService } from '../../prisma/prisma.service';
import { SymbolProfileService } from '../../symbol-profile/symbol-profile.service';
import {
  DataProviderInterface,
  GetDividendsParams,
  GetHistoricalParams,
  GetQuotesParams,
  GetSearchParams
} from '../interfaces/data-provider.interface';

@Injectable()
export class GoogleSheetsService implements DataProviderInterface {
  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly prismaService: PrismaService,
    private readonly symbolProfileService: SymbolProfileService
  ) {}

  public canHandle() {
    return true;
  }

  public async getAssetProfile({
    symbol
  }: {
    symbol: string;
  }): Promise<Partial<SymbolProfile>> {
    return {
      symbol,
      dataSource: this.getName()
    };
  }

  public getDataProviderInfo(): DataProviderInfo {
    return {
      isPremium: false,
      name: 'Google Sheets',
      url: 'https://docs.google.com/spreadsheets'
    };
  }

  public async getDividends({}: GetDividendsParams) {
    return {};
  }

  public async getHistorical({
    from,
    symbol,
    to
  }: GetHistoricalParams): Promise<
    Record<string, Record<string, IDataProviderHistoricalResponse>>
  > {
    try {
      const sheet = await this.getSheet({
        symbol,
        sheetId: this.configurationService.get('GOOGLE_SHEETS_ID')
      });

      const rows = await sheet.getRows();

      const historicalData: Record<string, IDataProviderHistoricalResponse> =
        {};

      rows
        .filter((_row, index) => {
          return index >= 1;
        })
        .forEach((row) => {
          const date = parseDate(row._rawData[0]);
          const close = parseFloat(row._rawData[1]);

          historicalData[format(date, DATE_FORMAT)] = { marketPrice: close };
        });

      return {
        [symbol]: historicalData
      };
    } catch (error) {
      throw new Error(
        `Could not get historical market data for ${symbol} (${this.getName()}) from ${format(
          from,
          DATE_FORMAT
        )} to ${format(to, DATE_FORMAT)}: [${error.name}] ${error.message}`
      );
    }
  }

  public getName(): DataSource {
    return DataSource.GOOGLE_SHEETS;
  }

  public async getQuotes({
    symbols
  }: GetQuotesParams): Promise<Record<string, IDataProviderResponse>> {
    const response: Record<string, IDataProviderResponse> = {};

    if (symbols.length <= 0) {
      return response;
    }

    try {
      const symbolProfiles = await this.symbolProfileService.getSymbolProfiles(
        symbols.map((symbol) => {
          return {
            symbol,
            dataSource: this.getName()
          };
        })
      );

      const sheet = await this.getSheet({
        sheetId: this.configurationService.get('GOOGLE_SHEETS_ID'),
        symbol: 'Overview'
      });

      const rows = await sheet.getRows();

      for (const row of rows) {
        const marketPrice = parseFloat(row['marketPrice']);
        const symbol = row['symbol'];

        if (symbols.includes(symbol)) {
          response[symbol] = {
            marketPrice,
            currency: symbolProfiles.find((symbolProfile) => {
              return symbolProfile.symbol === symbol;
            })?.currency,
            dataSource: this.getName(),
            marketState: 'delayed'
          };
        }
      }

      return response;
    } catch (error) {
      Logger.error(error, 'GoogleSheetsService');
    }

    return {};
  }

  public getTestSymbol() {
    return 'INDEXSP:.INX';
  }

  public async search({
    query
  }: GetSearchParams): Promise<{ items: LookupItem[] }> {
    const items = await this.prismaService.symbolProfile.findMany({
      select: {
        assetClass: true,
        assetSubClass: true,
        currency: true,
        dataSource: true,
        name: true,
        symbol: true
      },
      where: {
        OR: [
          {
            dataSource: this.getName(),
            name: {
              mode: 'insensitive',
              startsWith: query
            }
          },
          {
            dataSource: this.getName(),
            symbol: {
              mode: 'insensitive',
              startsWith: query
            }
          }
        ]
      }
    });

    return {
      items: items.map((item) => {
        return { ...item, dataProviderInfo: this.getDataProviderInfo() };
      })
    };
  }

  private async getSheet({
    sheetId,
    symbol
  }: {
    sheetId: string;
    symbol: string;
  }) {
    const doc = new GoogleSpreadsheet(sheetId);

    await doc.useServiceAccountAuth({
      client_email: this.configurationService.get('GOOGLE_SHEETS_ACCOUNT'),
      private_key: this.configurationService
        .get('GOOGLE_SHEETS_PRIVATE_KEY')
        .replace(/\\n/g, '\n')
    });

    await doc.loadInfo();

    const sheet = doc.sheetsByTitle[symbol];

    await sheet.loadCells();

    return sheet;
  }
}
