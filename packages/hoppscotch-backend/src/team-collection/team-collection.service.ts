import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TeamCollection } from './team-collection.model';
import {
  TEAM_COLL_SHORT_TITLE,
  TEAM_COLL_INVALID_JSON,
  TEAM_INVALID_COLL_ID,
  TEAM_NOT_OWNER,
  TEAM_COLL_NOT_FOUND,
  TEAM_COL_ALREADY_ROOT,
  TEAM_COLL_DEST_SAME,
  TEAM_COLL_NOT_SAME_TEAM,
  TEAM_COLL_IS_PARENT_COLL,
  TEAM_COL_SAME_NEXT_COLL,
  TEAM_COL_REORDERING_FAILED,
} from '../errors';
import { PubSubService } from '../pubsub/pubsub.service';
import { isValidLength } from 'src/utils';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import { Prisma, TeamCollection as DBTeamCollection } from '@prisma/client';
import { CollectionFolder } from 'src/types/CollectionFolder';
import { stringToJson } from 'src/utils';

@Injectable()
export class TeamCollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pubsub: PubSubService,
  ) {}

  TITLE_LENGTH = 3;

  /**
   * Generate a Prisma query object representation of a collection and its child collections and requests
   *
   * @param folder CollectionFolder from client
   * @param teamID The Team ID
   * @param orderIndex Initial OrderIndex of
   * @returns A Prisma query object to create a collection, its child collections and requests
   */
  private generatePrismaQueryObjForFBCollFolder(
    folder: CollectionFolder,
    teamID: string,
    orderIndex: number,
  ): Prisma.TeamCollectionCreateInput {
    return {
      title: folder.name,
      team: {
        connect: {
          id: teamID,
        },
      },
      requests: {
        create: folder.requests.map((r, index) => ({
          title: r.name,
          team: {
            connect: {
              id: teamID,
            },
          },
          request: r,
          orderIndex: index + 1,
        })),
      },
      orderIndex: orderIndex,
      children: {
        create: folder.folders.map((f, index) =>
          this.generatePrismaQueryObjForFBCollFolder(f, teamID, index + 1),
        ),
      },
    };
  }

  /**
   * Generate a JSON containing all the contents of a collection
   *
   * @param teamID The Team ID
   * @param collectionID The Collection ID
   * @returns A JSON string containing all the contents of a collection
   */
  private async exportCollectionToJSONObject(
    teamID: string,
    collectionID: string,
  ) {
    const collection = await this.getCollection(collectionID);
    if (E.isLeft(collection)) return E.left(TEAM_INVALID_COLL_ID);

    const childrenCollection = await this.prisma.teamCollection.findMany({
      where: {
        teamID,
        parentID: collectionID,
      },
      orderBy: {
        orderIndex: 'asc',
      },
    });

    const childrenCollectionObjects = [];
    for (const coll of childrenCollection) {
      const result = await this.exportCollectionToJSONObject(teamID, coll.id);
      if (E.isLeft(result)) return E.left(result.left);

      childrenCollectionObjects.push(result.right);
    }

    const requests = await this.prisma.teamRequest.findMany({
      where: {
        teamID,
        collectionID,
      },
      orderBy: {
        orderIndex: 'asc',
      },
    });

    const result: CollectionFolder = {
      name: collection.right.title,
      folders: childrenCollectionObjects,
      requests: requests.map((x) => x.request),
    };

    return E.right(result);
  }

  /**
   * Generate a JSON containing all the contents of collections and requests of a team
   *
   * @param teamID The Team ID
   * @returns A JSON string containing all the contents of collections and requests of a team
   */
  async exportCollectionsToJSON(teamID: string) {
    const rootCollections = await this.prisma.teamCollection.findMany({
      where: {
        teamID,
        parentID: null,
      },
    });

    const rootCollectionObjects = [];
    for (const coll of rootCollections) {
      const result = await this.exportCollectionToJSONObject(teamID, coll.id);
      if (E.isLeft(result)) return E.left(result.left);

      rootCollectionObjects.push(result.right);
    }

    return E.right(JSON.stringify(rootCollectionObjects));
  }

  /**
   * Create new TeamCollections and TeamRequests from JSON string
   *
   * @param jsonString The JSON string of the content
   * @param destTeamID The Team ID
   * @param destCollectionID The Collection ID
   * @returns An Either of a Boolean if the creation operation was successful
   */
  async importCollectionsFromJSON(
    jsonString: string,
    destTeamID: string,
    destCollectionID: string | null,
  ) {
    // Check to see if jsonString is valid
    const collectionsList = stringToJson<CollectionFolder[]>(jsonString);
    if (E.isLeft(collectionsList)) return E.left(TEAM_COLL_INVALID_JSON);

    // Check to see if parsed jsonString is an array
    if (!Array.isArray(collectionsList.right))
      return E.left(TEAM_COLL_INVALID_JSON);

    // Get number of root or child collections for destCollectionID(if destcollectionID != null) or destTeamID(if destcollectionID == null)
    const count = !destCollectionID
      ? await this.getRootCollectionsCount(destTeamID)
      : await this.getChildCollectionsCount(destCollectionID);

    // Generate Prisma Query Object for all child collections in collectionsList
    const queryList = collectionsList.right.map((x) =>
      this.generatePrismaQueryObjForFBCollFolder(x, destTeamID, count + 1),
    );

    const parent = destCollectionID
      ? {
          connect: {
            id: destCollectionID,
          },
        }
      : undefined;

    const teamCollections = await this.prisma.$transaction(
      queryList.map((x) =>
        this.prisma.teamCollection.create({
          data: {
            ...x,
            parent,
          },
        }),
      ),
    );

    teamCollections.forEach((x) =>
      this.pubsub.publish(`team_coll/${destTeamID}/coll_added`, x),
    );

    return E.right(true);
  }

  /**
   * Replace all the existing contents of a collection (or root collections) with data from JSON String
   *
   * @param jsonString The JSON string of the content
   * @param destTeamID The Team ID
   * @param destCollectionID The Collection ID
   * @returns An Either of a Boolean if the operation was successful
   */
  async replaceCollectionsWithJSON(
    jsonString: string,
    destTeamID: string,
    destCollectionID: string | null,
  ) {
    // Check to see if jsonString is valid
    const collectionsList = stringToJson<CollectionFolder[]>(jsonString);
    if (E.isLeft(collectionsList)) return E.left(TEAM_COLL_INVALID_JSON);

    // Check to see if parsed jsonString is an array
    if (!Array.isArray(collectionsList.right))
      return E.left(TEAM_COLL_INVALID_JSON);

    // Fetch all child collections of destCollectionID
    const childrenCollection = await this.prisma.teamCollection.findMany({
      where: {
        teamID: destTeamID,
        parentID: destCollectionID,
      },
    });

    for (const coll of childrenCollection) {
      const deletedTeamCollection = await this.deleteCollection(coll.id);
      if (E.isLeft(deletedTeamCollection))
        return E.left(deletedTeamCollection.left);
    }

    // Get number of root or child collections for destCollectionID(if destcollectionID != null) or destTeamID(if destcollectionID == null)
    const count = !destCollectionID
      ? await this.getRootCollectionsCount(destTeamID)
      : await this.getChildCollectionsCount(destCollectionID);

    const queryList = collectionsList.right.map((x) =>
      this.generatePrismaQueryObjForFBCollFolder(x, destTeamID, count + 1),
    );

    const parent = destCollectionID
      ? {
          connect: {
            id: destCollectionID,
          },
        }
      : undefined;

    const teamCollections = await this.prisma.$transaction(
      queryList.map((x) =>
        this.prisma.teamCollection.create({
          data: {
            ...x,
            parent,
          },
        }),
      ),
    );

    teamCollections.forEach((x) =>
      this.pubsub.publish(`team_coll/${destTeamID}/coll_added`, x),
    );

    return E.right(true);
  }

  /**
   * Typecast a database TeamCollection to a TeamCollection model
   * @param teamCollection database TeamCollection
   * @returns TeamCollection model
   */
  private cast(teamCollection: DBTeamCollection): TeamCollection {
    return <TeamCollection>{ ...teamCollection };
  }

  /**
   * Get Team of given Collection ID
   *
   * @param collectionID The collection ID
   * @returns Team of given Collection ID
   */
  async getTeamOfCollection(collectionID: string) {
    try {
      const teamCollection = await this.prisma.teamCollection.findUnique({
        where: {
          id: collectionID,
        },
        include: {
          team: true,
        },
      });

      return E.right(teamCollection.team);
    } catch (error) {
      return E.left(TEAM_INVALID_COLL_ID);
    }
  }

  /**
   * Get parent of given Collection ID
   *
   * @param collectionID The collection ID
   * @returns Parent TeamCollection of given Collection ID
   */
  async getParentOfCollection(collectionID: string) {
    const teamCollection = await this.prisma.teamCollection.findUnique({
      where: {
        id: collectionID,
      },
      include: {
        parent: true,
      },
    });
    if (!teamCollection) return null;

    return teamCollection.parent;
  }

  /**
   * Get child collections of given Collection ID
   *
   * @param collectionID The collection ID
   * @param cursor collectionID for pagination
   * @param take Number of items we want returned
   * @returns A list of child collections
   */
  getChildrenOfCollection(
    collectionID: string,
    cursor: string | null,
    take: number,
  ) {
    return this.prisma.teamCollection.findMany({
      where: {
        parentID: collectionID,
      },
      orderBy: {
        title: 'asc',
      },
      take: take, // default: 10
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
    });
  }

  /**
   * Get root collections of given Collection ID
   *
   * @param teamID The Team ID
   * @param cursor collectionID for pagination
   * @param take Number of items we want returned
   * @returns A list of root TeamCollections
   */
  async getTeamRootCollections(
    teamID: string,
    cursor: string | null,
    take: number,
  ) {
    return this.prisma.teamCollection.findMany({
      where: {
        teamID,
        parentID: null,
      },
      orderBy: {
        title: 'asc',
      },
      take: take, // default: 10
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
    });
  }

  /**
   * Get collection details
   *
   * @param collectionID The collection ID
   * @returns An Either of the Collection details
   */
  async getCollection(collectionID: string) {
    try {
      const teamCollection = await this.prisma.teamCollection.findUniqueOrThrow(
        {
          where: {
            id: collectionID,
          },
        },
      );
      return E.right(teamCollection);
    } catch (error) {
      return E.left(TEAM_COLL_NOT_FOUND);
    }
  }

  /**
   * Check to see if Collection belongs to Team
   *
   * @param collectionID getChildCollectionsCount
   * @param teamID The Team ID
   * @returns An Option of a Boolean
   */
  private async isOwnerCheck(collectionID: string, teamID: string) {
    try {
      await this.prisma.teamCollection.findFirstOrThrow({
        where: {
          id: collectionID,
          teamID,
        },
      });

      return O.some(true);
    } catch (error) {
      return O.none;
    }
  }

  /**
   * Returns the count of child collections present for a given collectionID
   * * The count returned is highest OrderIndex + 1
   *
   * @param collectionID The Collection ID
   * @returns Number of Child Collections
   */
  private async getChildCollectionsCount(collectionID: string) {
    const childCollectionCount = await this.prisma.teamCollection.findMany({
      where: { parentID: collectionID },
      orderBy: {
        orderIndex: 'desc',
      },
    });
    if (!childCollectionCount.length) return 0;
    return childCollectionCount[0].orderIndex;
  }

  /**
   * Returns the count of root collections present for a given teamID
   * * The count returned is highest OrderIndex + 1
   *
   * @param teamID The Team ID
   * @returns Number of Root Collections
   */
  private async getRootCollectionsCount(teamID: string) {
    const rootCollectionCount = await this.prisma.teamCollection.findMany({
      where: { teamID, parentID: null },
      orderBy: {
        orderIndex: 'desc',
      },
    });
    if (!rootCollectionCount.length) return 0;
    return rootCollectionCount[0].orderIndex;
  }

  /**
   * Create a new TeamCollection
   *
   * @param teamID The Team ID
   * @param title The title of new TeamCollection
   * @param parentTeamCollectionID The parent collectionID (null if root collection)
   * @returns An Either of TeamCollection
   */
  async createCollection(
    teamID: string,
    title: string,
    parentTeamCollectionID: string | null,
  ) {
    const isTitleValid = isValidLength(title, this.TITLE_LENGTH);
    if (!isTitleValid) return E.left(TEAM_COLL_SHORT_TITLE);

    // Check to see if parentTeamCollectionID belongs to this Team
    if (parentTeamCollectionID !== null) {
      const isOwner = await this.isOwnerCheck(parentTeamCollectionID, teamID);
      if (O.isNone(isOwner)) return E.left(TEAM_NOT_OWNER);
    }

    const isParent = parentTeamCollectionID
      ? {
          connect: {
            id: parentTeamCollectionID,
          },
        }
      : undefined;

    const teamCollection = await this.prisma.teamCollection.create({
      data: {
        title: title,
        team: {
          connect: {
            id: teamID,
          },
        },
        parent: isParent,
        orderIndex: !parentTeamCollectionID
          ? (await this.getRootCollectionsCount(teamID)) + 1
          : (await this.getChildCollectionsCount(parentTeamCollectionID)) + 1,
      },
    });

    this.pubsub.publish(`team_coll/${teamID}/coll_added`, teamCollection);

    return E.right(this.cast(teamCollection));
  }

  /**
   * Update the title of a TeamCollection
   *
   * @param collectionID The Collection ID
   * @param newTitle The new title of collection
   * @returns An Either of the updated TeamCollection
   */
  async renameCollection(collectionID: string, newTitle: string) {
    const isTitleValid = isValidLength(newTitle, this.TITLE_LENGTH);
    if (!isTitleValid) return E.left(TEAM_COLL_SHORT_TITLE);

    try {
      const updatedTeamCollection = await this.prisma.teamCollection.update({
        where: {
          id: collectionID,
        },
        data: {
          title: newTitle,
        },
      });

      this.pubsub.publish(
        `team_coll/${updatedTeamCollection.teamID}/coll_updated`,
        updatedTeamCollection,
      );

      return E.right(updatedTeamCollection);
    } catch (error) {
      return E.left(TEAM_COLL_NOT_FOUND);
    }
  }

  /**
   * Update the OrderIndex of all collections in given parentID
   *
   * @param parentID The Parent collectionID
   * @param orderIndexCondition Condition to decide what collections will be updated
   * @param dataCondition Increment/Decrement OrderIndex condition
   * @returns A Collection with updated OrderIndexes
   */
  private async updateOrderIndex(
    parentID: string,
    orderIndexCondition: Prisma.IntFilter,
    dataCondition: Prisma.IntFieldUpdateOperationsInput,
  ) {
    const updatedTeamCollection = await this.prisma.teamCollection.updateMany({
      where: {
        parentID: parentID,
        orderIndex: orderIndexCondition,
      },
      data: { orderIndex: dataCondition },
    });

    return updatedTeamCollection;
  }

  /**
   * Delete a TeamCollection from the DB
   *
   * @param collectionID The Collection Id
   * @returns The deleted TeamCollection
   */
  private async removeTeamCollection(collectionID: string) {
    try {
      const deletedTeamCollection = await this.prisma.teamCollection.delete({
        where: {
          id: collectionID,
        },
      });

      return E.right(deletedTeamCollection);
    } catch (error) {
      return E.left(TEAM_COLL_NOT_FOUND);
    }
  }

  /**
   * Delete child collection and requests of a TeamCollection
   *
   * @param collectionID The Collection Id
   * @returns A Boolean of deletion status
   */
  private async deleteCollectionData(collection: DBTeamCollection) {
    // Get all child collections in collectionID
    const childCollectionList = await this.prisma.teamCollection.findMany({
      where: {
        parentID: collection.id,
      },
    });

    // Delete child collections
    await Promise.all(
      childCollectionList.map((coll) => this.deleteCollection(coll.id)),
    );

    // Delete all requests in collectionID
    await this.prisma.teamRequest.deleteMany({
      where: {
        collectionID: collection.id,
      },
    });

    // Delete collection from TeamCollection table
    const deletedTeamCollection = await this.removeTeamCollection(
      collection.id,
    );
    if (E.isLeft(deletedTeamCollection))
      return E.left(deletedTeamCollection.left);

    this.pubsub.publish(
      `team_coll/${deletedTeamCollection.right.teamID}/coll_removed`,
      deletedTeamCollection.right.id,
    );

    return E.right(deletedTeamCollection.right);
  }

  /**
   * Delete a TeamCollection
   *
   * @param collectionID The Collection Id
   * @returns An Either of Boolean of deletion status
   */
  async deleteCollection(collectionID: string) {
    const collection = await this.getCollection(collectionID);
    if (E.isLeft(collection)) return E.left(collection.left);

    // Delete all child collections and requests in the collection
    const collectionData = await this.deleteCollectionData(collection.right);
    if (E.isLeft(collectionData)) return E.left(collectionData.left);

    // Update orderIndexes in TeamCollection table for user
    await this.updateOrderIndex(
      collectionData.right.parentID,
      { gt: collectionData.right.orderIndex },
      { decrement: 1 },
    );

    return E.right(true);
  }

  /**
   * Change parentID of TeamCollection's
   *
   * @param collectionID The collection ID
   * @param parentCollectionID The new parent's collection ID or change to root collection
   * @returns  If successful return an Either of true
   */
  private async changeParent(
    collection: DBTeamCollection,
    parentCollectionID: string | null,
  ) {
    try {
      let collectionCount: number;

      if (!parentCollectionID)
        collectionCount = await this.getRootCollectionsCount(collection.teamID);
      collectionCount = await this.getChildCollectionsCount(parentCollectionID);

      const updatedCollection = await this.prisma.teamCollection.update({
        where: {
          id: collection.id,
        },
        data: {
          // if parentCollectionID == null, collection becomes root collection
          // if parentCollectionID != null, collection becomes child collection
          parentID: parentCollectionID,
          orderIndex: collectionCount + 1,
        },
      });

      return E.right(this.cast(updatedCollection));
    } catch (error) {
      return E.left(TEAM_COLL_NOT_FOUND);
    }
  }

  /**
   * Check if collection is parent of destCollection
   *
   * @param collection The ID of collection being moved
   * @param destCollection The ID of collection into which we are moving target collection into
   * @returns An Option of boolean, is parent or not
   */
  private async isParent(
    collection: TeamCollection,
    destCollection: TeamCollection,
  ): Promise<O.Option<boolean>> {
    //* Recursively check if collection is a parent by going up the tree of child-parent collections until we reach a root collection i.e parentID === null
    //* Valid condition, isParent returns false
    //* Consider us moving Collection_E into Collection_D
    //* Collection_A              [parent:null !== Collection_E] return false, exit
    //*   |--> Collection_B       [parent:Collection_A !== Collection_E] call isParent(Collection_E,Collection_A)
    //*      |--> Collection_C    [parent:Collection_B !== Collection_E] call isParent(Collection_E,Collection_B)
    //*         |--> Collection_D [parent:Collection_C !== Collection_E] call isParent(Collection_E,Collection_C)
    //* Invalid condition, isParent returns true
    //* Consider us moving Collection_B into Collection_D
    //* Collection_A
    //*   |--> Collection_B
    //*      |--> Collection_C    [parent:Collection_B === Collection_B] return true, exit
    //*         |--> Collection_D [parent:Collection_C !== Collection_B] call isParent(Collection_B,Collection_C)

    // Check if collection and destCollection are same
    if (collection === destCollection) {
      return O.none;
    }
    if (destCollection.parentID !== null) {
      // Check if ID of collection is same as parent of destCollection
      if (destCollection.parentID === collection.id) {
        return O.none;
      }
      // Get collection details of collection one step above in the tree i.e the parent collection
      const parentCollection = await this.getCollection(
        destCollection.parentID,
      );
      if (E.isLeft(parentCollection)) {
        return O.none;
      }
      // Call isParent again now with parent collection
      return await this.isParent(collection, parentCollection.right);
    } else {
      return O.some(true);
    }
  }

  /**
   * Move TeamCollection into root or another collection
   *
   * @param collectionID The ID of collection being moved
   * @param destCollectionID The ID of collection the target collection is being moved into or move target collection to root
   * @returns An Either of the moved TeamCollection
   */
  async moveCollection(collectionID: string, destCollectionID: string | null) {
    // Get collection details of collectionID
    const collection = await this.getCollection(collectionID);
    if (E.isLeft(collection)) return E.left(collection.left);

    // destCollectionID == null i.e move collection to root
    if (!destCollectionID) {
      if (!collection.right.parentID) {
        // collection is a root collection
        // Throw error if collection is already a root collection
        return E.left(TEAM_COL_ALREADY_ROOT);
      }
      // Move child collection into root and update orderIndexes for root teamCollections
      await this.updateOrderIndex(
        collection.right.parentID,
        { gt: collection.right.orderIndex },
        { decrement: 1 },
      );

      // Change parent from child to root i.e child collection becomes a root collection
      const updatedCollection = await this.changeParent(collection.right, null);
      if (E.isLeft(updatedCollection)) return E.left(updatedCollection.left);

      this.pubsub.publish(
        `team_coll/${collection.right.teamID}/coll_moved`,
        updatedCollection.right,
      );

      return E.right(updatedCollection.right);
    }

    // destCollectionID != null i.e move into another collection
    if (collectionID === destCollectionID) {
      // Throw error if collectionID and destCollectionID are the same
      return E.left(TEAM_COLL_DEST_SAME);
    }

    // Get collection details of destCollectionID
    const destCollection = await this.getCollection(destCollectionID);
    if (E.isLeft(destCollection)) return E.left(TEAM_COLL_NOT_FOUND);

    // Check if collection and destCollection belong to the same user account
    if (collection.right.teamID !== destCollection.right.teamID) {
      return E.left(TEAM_COLL_NOT_SAME_TEAM);
    }

    // Check if collection is present on the parent tree for destCollection
    const checkIfParent = await this.isParent(
      collection.right,
      destCollection.right,
    );
    if (O.isNone(checkIfParent)) {
      return E.left(TEAM_COLL_IS_PARENT_COLL);
    }

    // Move root/child collection into another child collection and update orderIndexes of the previous parent
    await this.updateOrderIndex(
      collection.right.parentID,
      { gt: collection.right.orderIndex },
      { decrement: 1 },
    );

    // Change parent from null to teamCollection i.e collection becomes a child collection
    const updatedCollection = await this.changeParent(
      collection.right,
      destCollection.right.id,
    );
    if (E.isLeft(updatedCollection)) return E.left(updatedCollection.left);

    this.pubsub.publish(
      `team_coll/${collection.right.teamID}/coll_moved`,
      updatedCollection.right,
    );

    return E.right(updatedCollection.right);
  }

  /**
   * Find the number of child collections present in collectionID
   *
   * @param collectionID The Collection ID
   * @returns Number of collections
   */
  getCollectionCount(collectionID: string): Promise<number> {
    return this.prisma.teamCollection.count({
      where: { parentID: collectionID },
    });
  }

  /**
   * Update order of root or child collectionID's
   *
   * @param collectionID The ID of collection being re-ordered
   * @param nextCollectionID The ID of collection that is after the moved collection in its new position
   * @returns If successful return an Either of true
   */
  async updateCollectionOrder(
    collectionID: string,
    nextCollectionID: string | null,
  ) {
    // Throw error if collectionID and nextCollectionID are the same
    if (collectionID === nextCollectionID)
      return E.left(TEAM_COL_SAME_NEXT_COLL);

    // Get collection details of collectionID
    const collection = await this.getCollection(collectionID);
    if (E.isLeft(collection)) return E.left(collection.left);

    if (!nextCollectionID) {
      // nextCollectionID == null i.e move collection to the end of the list
      try {
        await this.prisma.$transaction(async (tx) => {
          // Step 1: Decrement orderIndex of all items that come after collection.orderIndex till end of list of items
          await tx.teamCollection.updateMany({
            where: {
              parentID: collection.right.parentID,
              orderIndex: {
                gte: collection.right.orderIndex + 1,
              },
            },
            data: {
              orderIndex: { decrement: 1 },
            },
          });
          // Step 2: Update orderIndex of collection to length of list
          const updatedTeamCollection = await tx.teamCollection.update({
            where: { id: collection.right.id },
            data: {
              orderIndex: await this.getCollectionCount(
                collection.right.parentID,
              ),
            },
          });
        });

        this.pubsub.publish(
          `team_coll/${collection.right.teamID}/coll_order_updated`,
          {
            collection: this.cast(collection.right),
            nextCollection: null,
          },
        );

        return E.right(true);
      } catch (error) {
        return E.left(TEAM_COL_REORDERING_FAILED);
      }
    }

    // nextCollectionID != null i.e move to a certain position
    // Get collection details of nextCollectionID
    const subsequentCollection = await this.getCollection(nextCollectionID);
    if (E.isLeft(subsequentCollection)) return E.left(TEAM_COLL_NOT_FOUND);

    // Check if collection and subsequentCollection belong to the same collection team
    if (collection.right.teamID !== subsequentCollection.right.teamID)
      return E.left(TEAM_COLL_NOT_SAME_TEAM);

    try {
      await this.prisma.$transaction(async (tx) => {
        // Step 1: Determine if we are moving collection up or down the list
        const isMovingUp =
          subsequentCollection.right.orderIndex < collection.right.orderIndex;
        // Step 2: Update OrderIndex of items in list depending on moving up or down
        const updateFrom = isMovingUp
          ? subsequentCollection.right.orderIndex
          : collection.right.orderIndex + 1;

        const updateTo = isMovingUp
          ? collection.right.orderIndex - 1
          : subsequentCollection.right.orderIndex - 1;

        await tx.teamCollection.updateMany({
          where: {
            parentID: collection.right.parentID,
            orderIndex: { gte: updateFrom, lte: updateTo },
          },
          data: {
            orderIndex: isMovingUp ? { increment: 1 } : { decrement: 1 },
          },
        });
        // Step 3: Update OrderIndex of collection
        const updatedTeamCollection = await tx.teamCollection.update({
          where: { id: collection.right.id },
          data: {
            orderIndex: isMovingUp
              ? subsequentCollection.right.orderIndex
              : subsequentCollection.right.orderIndex - 1,
          },
        });
      });

      this.pubsub.publish(
        `team_coll/${collection.right.teamID}/coll_order_updated`,
        {
          collection: this.cast(collection.right),
          nextCollection: this.cast(subsequentCollection.right),
        },
      );

      return E.right(true);
    } catch (error) {
      return E.left(TEAM_COL_REORDERING_FAILED);
    }
  }

  /**
   * Fetch list of all the Team Collections in DB for a particular team
   * @param teamID Team ID
   * @returns number of Team Collections in the DB
   */
  async totalCollectionsInTeam(teamID: string) {
    const collCount = await this.prisma.teamCollection.count({
      where: {
        teamID: teamID,
      },
    });

    return collCount;
  }

  /**
   * Fetch list of all the Team Collections in DB
   *
   * @returns number of Team Collections in the DB
   */
  async getTeamCollectionsCount() {
    const teamCollectionsCount = this.prisma.teamCollection.count();
    return teamCollectionsCount;
  }
}
